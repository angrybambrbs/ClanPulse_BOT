// ClanPulse Discord bot
// Команды: !кланы, !зона, !стат, !тактики, !help
// Данные берутся из Supabase напрямую по REST (публичные view/RPC — без ключей).

const http = require('http');
const { Client, GatewayIntentBits, EmbedBuilder, TextChannel } = require('discord.js');

const COMMIT = process.env.RENDER_GIT_COMMIT || 'local';
const STARTED_AT = Date.now();
const runtimeStatus = {
  commit: COMMIT,
  startedAt: new Date(STARTED_AT).toISOString(),
  ready: false,
  botTag: null,
  guilds: [],
  commands: null,
  lastError: null,
};
let clientRef = null;

// Render Web Service требует HTTP-сервер, который отвечает на health check '/'.
const PORT = Number(process.env.PORT) || 10000;
http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else if (req.url === '/status') {
    const live = clientRef;
    const body = JSON.stringify({
      ...runtimeStatus,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      live: live ? {
        ready: live.isReady(),
        botTag: live.user ? live.user.tag : null,
        appId: live.application ? live.application.id : null,
        guilds: live.guilds.cache.map(g => ({ id: g.id, name: g.name })),
      } : null,
    }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Health server listening on ${PORT} · commit ${COMMIT}`));

const config = {
  botToken: process.env.BOT_TOKEN,
  announcementsChannel: process.env.CHANNEL_ID, // куда писать рассылки
};

const SB = {
  base: (process.env.SUPABASE_URL || 'https://jzfaggufycangmgwuuks.supabase.co').replace(/\/$/, ''),
};

const SB2 = {
  base: SB.base,
  anonKey: SB.anonKey,
};

async function sbGet(path) {
  // Публичные view/RLS у кланов дергают helper-функции, которые anon-роли недоступны.
  // Бот — серверный компонент, поэтому читаем теми же service-правами, что и пишем.
  return sbService(path, 'GET');
}

function serviceKey() {
  return String(process.env.SUPABASE_SERVICE_ROLE || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

async function sbService(path, method = 'POST', body) {
  const key = serviceKey();
  const opts = { method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) };
  if (key) opts.headers.Authorization = 'Bearer ' + key;
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(SB.base + '/rest/v1/' + path, opts);
    if (!r.ok) { console.error('Supabase error', r.status, path, (await r.text()).slice(0, 200)); return null; }
    return r.status === 204 ? null : await r.json().catch(() => null);
  } catch (e) {
    console.error('Supabase request failed', path, e.message);
    return null;
  }
}

// Безопасное описание ключа: без самого значения, только тип/роль/проект.
function describeKey(key) {
  if (!key) return { present: false, kind: 'НЕ задан' };
  const info = { present: true, kind: 'unknown', length: key.length };
  if (key.startsWith('sb_secret_')) info.kind = 'sb_secret (secret key)';
  else if (key.startsWith('sb_publishable_')) info.kind = 'sb_publishable (ПУБЛИЧНЫЙ ключ, не service role)';
  else if (key.startsWith('eyJ')) {
    info.kind = 'jwt';
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
      info.role = payload.role;
      info.ref = payload.ref;
      info.exp = payload.exp ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : null;
    } catch { info.kind = 'jwt (не удалось разобрать)'; }
  }
  return info;
}

async function sbProbe(path) {
  const key = serviceKey();
  const opts = { method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) };
  if (key) opts.headers.Authorization = 'Bearer ' + key;
  try {
    const r = await fetch(SB.base + '/rest/v1/' + path, opts);
    return { status: r.status, body: (await r.text()).slice(0, 240) };
  } catch (e) {
    return { status: 0, body: e.message.slice(0, 240) };
  }
}

async function fetchClans() {
  // Не clan_directory: этот view фильтрует по auth.uid(), у сервисного ключа его нет.
  const r = await sbService('clans?select=id,name,tier,about,min_gear_level&limit=50');
  return r && Array.isArray(r) ? r : [];
}

async function fetchActiveGames() {
  const r = await sbGet('clan_events?select=id,clan_id,title,starts_at,kind&order=starts_at.asc');
  return r && Array.isArray(r) ? r : [];
}
async function fetchActiveGamesService(clanId) {
  const filter = clanId ? `&clan_id=eq.${clanId}` : '';
  const r = await sbService(`clan_events?select=id,clan_id,title,starts_at,kind&order=starts_at.asc${filter}`);
  return r && Array.isArray(r) ? r : [];
}
// Доп. запросы: рейтинги/поиск/контакты/события/история
async function fetchLeaderboard(mode) {
  const s = mode || 'kda';
  if (s === 'kd') return (await sbService('match_stats?select=player_id,clan_id,kills,deaths&limit=100')).slice(0, 20);
  const r = await sbService('match_stats?select=player_id,kills,deaths,assists,clan_id&order=kills.desc&limit=50');
  return r || [];
}
async function fetchLeaderboardForClan(clanId) {
  const r = await sbService('match_stats?select=player_id,kills,deaths,assists,clan_id&order=kills.desc&limit=500');
  return (r || []).filter(x => !clanId || x.clan_id === clanId).slice(0, 50);
}
async function fetchClansByName(q) {
  const r = await sbService('clans?select=id,name,min_gear_level,tier,about&limit=50');
  const qn = normNick(q);
  return (r || []).filter(x => normNick(x.name).includes(qn));
}
async function fetchClanByPlayer(nick) {
  const r = await sbService('players?select=nick,clan_id&limit=500');
  const p = (r || []).find(x => normNick(x.nick).includes(normNick(nick)));
  if (!p || !p.clan_id) return null;
  const c = await sbService('clans?select=id,name&id=eq.' + p.clan_id);
  return c && c[0] ? c[0] : null;
}
async function fetchEvents() {
  const r = await sbService('clan_events?select=id,clan_id,title,starts_at,kind,location&order=starts_at.asc&limit=20');
  return r || [];
}
async function fetchMatches() {
  const r = await sbService('matches?select=id,clan_id,played_at,mode,result,place,team_score,extra&order=played_at.desc&limit=50');
  return r || [];
}
function normNick(s) { return String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, ''); }

// ── Block A: оптимистичная статистика успешности ──
const statState = { week: null, matches: 0, parseFail: 0 };
async function gatherStats() {
  const ms = await sbService('matches?select=id&limit=500');
  statState.matches = (ms && ms.length) || 0;
  saveBridgeState();
}
async function statDigest() {
  const ch = await fetchChannelLinks();
  if (!ch.length) return;
  const msg = `📊 **Статистика на этой неделе**\n- Матчей собрано: ${statState.matches}\n- Не распознано скриншотов: ${statState.parseFail}`;
  await postToDiscord(ch[0].channel_id, msg);
  statState.matches = 0; statState.parseFail = 0;
}
// ── Block B: разбор нераспознанных скриншотов ──
async function repostUnrecognizedDigest() {
  const ms = await sbService('matches?select=id,played_at,clan_id,extra&order=played_at.desc&limit=30');
  const rows = (ms || []).filter(m => !m || !m.extra || m.extra.source !== 'recognized');
  if (!rows.length) return;
  const ch = await fetchChannelLinks();
  if (!ch.length) return;
  const lines = rows.slice(0, 8).map(m => `- ${new Date(m.played_at).toLocaleDateString('ru')} — матч \`${m.id}\``).join('\n');
  await postToDiscord(ch[0].channel_id, `🔍 **Матчи без статистики**\n${lines}`);
}
async function postEventsDigest() {
  const links = await fetchChannelLinks();
  if (!links.length) return;
  for (const link of links) {
    const games = await fetchActiveGamesService(link.clan_id);
    if (!games.length) continue;
    const title = '⚡ ClanPulse — события' + (link.name ? ` · ${link.name}` : '');
    const e = embed({ title, description: games.slice(0, 10).map((t) => `- **${t.title}** (${new Date(t.starts_at).toLocaleString('ru')})`).join('\n') });
    await postToDiscord(link.channel_id, e).catch(() => null);
  }
}

async function fetchStats() {
  const r = await sbGet('rpc/site_stats');
  return r && typeof r === 'object' ? r : null;
}
async function fetchChannelLinks() {
  const r = await sbGet('clan_channels?order=created_at.asc');
  return r && Array.isArray(r) ? r : [];
}
async function fetchUnpostedSiteMessages(channelIds) {
  if (!channelIds.length) return [];
  const or = channelIds.map((c) => `and(channel_id.eq.${c},source.eq.site)`).join(',');
  const r = await sbGet('clan_messages?select=id,body,created_at&or=(' + or + ').order=created_at.asc&limit=50');
  return r && Array.isArray(r) ? r : [];
}
async function postToDiscord(channelId, body) {
  if (!config.botToken) return null;
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + config.botToken },
    body: JSON.stringify({ content: body, allowedMentions: { parse: [] } }),
  });
  return r.json().catch(() => null);
}

async function fetchGallery() {
  const r = await sbGet('tactics_gallery?select=title,map_key,author_id,created_at&order=created_at.desc&limit=15');
  return r && Array.isArray(r) ? r : [];
}

const embed = (e) => new EmbedBuilder(e).setColor('#5865f2').setTimestamp();

async function handleCommand(cmd, message, args = []) {
  const channel = message.channel;

  if (cmd === 'debug') {
    const key = describeKey(serviceKey());
    const urlRef = (() => { try { return new URL(SB.base).hostname.split('.')[0]; } catch { return '?'; } })();
    const probe = async (p) => { const r = await sbProbe(p); return `${r.status} ${r.body}`; };
    const clans = await probe('clans?select=id,name&limit=1');
    const members = await probe('clan_members?select=clan_id&limit=1');
    const dir = await probe('clan_directory?select=id&limit=1');
    return channel.send(
      '🔧 **Диагностика Supabase**\n' +
      `- URL: ${SB.base} (ref ${urlRef})\n` +
      `- SERVICE_ROLE: ${key.present ? 'задан' : 'НЕ задан'} · ${key.kind}` +
        (key.role ? ` · role=${key.role}` : '') +
        (key.ref ? ` · ref=${key.ref}` : '') +
        (key.exp ? ` · exp=${key.exp}` : '') +
        (key.length ? ` · длина=${key.length}` : '') + '\n' +
      `- clans: ${clans}\n` +
      `- clan_members: ${members}\n` +
      `- clan_directory: ${dir}`
    );
  }

  if (cmd === 'кланы' || cmd === 'clans') {
    const data = await fetchClans();
    const e = embed({
      title: `Кланы (${data.length})`,
      description: data.map((c) => `- **${c.name}** — ${c.tier || '…'}`).join('\n') || 'Кланы не найдены.',
    });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'зона' || cmd === 'events') {
    const data = await fetchActiveGames();
    const e = embed({
      title: 'Зона — активные задания',
      description: data.length
        ? data.map((t) => `- **${t.title}** (${new Date(t.starts_at).toLocaleString('ru')})`).join('\n')
        : 'Нет активных заданий.',
    });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'стат' || cmd === 'stats') {
    const data = await fetchStats();
    const keys = { clans: 'Кланов', players: 'Игроков', matches: 'Боёв', gallery: 'Тактик', events: 'Событий', messages: 'Сообщений', sections: 'Разделов' };
    const e = embed({ title: 'Общая статистика площадки' });
    Object.entries(keys).forEach(([k, l]) => e.fields.push({ name: l, value: String(data ? data[k] ?? '—' : '—'), inline: true }));
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'тактики' || cmd === 'gallery') {
    const data = await fetchGallery();
    const e = embed({
      title: 'Галерея тактик',
      description: data.slice(0, 12).map((g) => `- **${g.title || 'Без названия'}** — карта \`${g.map_key}\``).join('\n'),
    });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'help' || cmd === 'помощь') {
    return channel.send(
      '🌏 **ClanPulse Бот** в Discord (slash-команды)\n' +
      '- 🔍 **/clans** — список кланов\n' +
      '- 📋 **/zone** — активные задания\n' +
      '- 📈 **/stats** — общая статистика\n' +
      '- 🗺 **/tactics** — галерея планов\n' +
      '- 🔗 **/link clan:<название>** — привязать этот канал к клану с сайта\n' +
      '- ℹ️ **/help** — справка'
    );
  }

  if (cmd === 'чат' || cmd === 'link') {
    const clanQuery = String(args[0] || '').trim();
    const channelId = String(args[1] || message.channelId || '').trim();
    if (!clanQuery) return channel.send('Укажи клан: **/link clan:<название>**');
    if (!/^[0-9]{10,}$/.test(channelId)) return channel.send('Не удалось определить ID канала. Укажи его вручную: **/link clan:<название> channel_id:<id>**');
    const found = await fetchClansByName(clanQuery);
    if (!found.length) return channel.send(`Клан «${escArg(clanQuery)}» не найден на сайте. Сначала создай его на сайте.`);
    const clan = found[0];
    await sbService(`clan_channels?channel_id=eq.${channelId}`, 'DELETE');
    await sbService('clan_channels', 'POST', {
      name: clan.name,
      clan_id: clan.id,
      channel_id: channelId,
      created_at: new Date().toISOString(),
    });
    return channel.send(`✅ Канал <#${channelId}> привязан к клану **${escArg(clan.name)}**. Сюда будут приходить события, задания и чат клана с сайта.`);
  }

  if (cmd === 'матч' || cmd === 'match') {
    const key = message.author.id;
    matchCollect.set(key, {});
    await channel.send(`ℹ️ Прикрепи скриншот матча — он обязателен, потом напиши **стадия: 1/2/3**.`);
    return;
  }

  if (cmd === 'заявки' || cmd === 'apps') {
    const r = await sbService('clan_applications?select=id,clan_name,status,user_id,created_at&order=created_at.desc&limit=20', 'GET');
    const data = r && Array.isArray(r) ? r : [];
    const e = embed({ title: 'Заявки в кланы (site)', description: data.map(a => `${a.status === 'pending' ? '🔴' : '🟢'} \`${a.id}\` — ${a.clan_name} (${a.status})`).join('\n') || 'Нет заявок.' });
    return channel.send({ embeds: [e] });
  }
  if (cmd === 'рейтинг' || cmd === 'rating') {
    const d = await sbService('clans?select=id,name&limit=5');
    const clanId = d && d[0] ? d[0].id : null;
    const stats = await fetchLeaderboardForClan(clanId);
    const e = embed({ title: `🏆 Лидеры рейтинга (первый активный клан)`, description: stats.slice(0, 15).map((s, i) => `${i + 1}. **#${s.player_id}** — ${s.kills}K / ${s.deaths}D / ${s.assists}P`).join('\n') || 'Нет данных.' });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'поиск' || cmd === 'search') {
    const q = args.join(' ').trim();
    const found = await fetchClansByName(q || '');
    const e = embed({ title: `Кланы — ${escArg(q)}`, description: found.map(c => `🏰 **${c.name}** — тир ${c.tier || '?'}${c.about ? ' — ' + c.about : ''}`).join('\n') || 'Ничего не найдено.' });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'контакт' || cmd === 'contact') {
    const q = args.join(' ').trim();
    const c = await fetchClanByPlayer(q);
    if (!c) return channel.send('Клан игрока «' + escArg(q) + '» не найден.');
    const e = embed({ title: 'Контакт клана', description: `**${escArg(c.name)}** — ссылка для присоединения: используйте команду **!поиск <название>** или откройте на сайте: ${escArg(c.name)}` });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'неподтверждено' || cmd === 'unconfirmed') {
    const r = await sbService('match_stats?select=match_id,clan_id,extra,confirmed&order=confirmed.notnull.desc&limit=30');
    const rows = (r || []).filter(x => x.confirmed === false);
    const e = embed({ title: '⚠️ Матчи без подтверждённой статистики', description: rows.length ? rows.map(x => `- \`${x.match_id}\` — ${new Date(x.created_at || '').toLocaleDateString('ru')}${x.extra && x.extra.stage ? ' · стадия ' + x.extra.stage : ''}`).join('\n') : 'Все подтверждено.' });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'править' || cmd === 'fix') {
    const id = args[0], result = args.slice(1).join(' ').toLowerCase();
    if (!id || !['победа', 'побед', 'поражение', 'проигрыш', 'ничья'].includes(result)) {
      return channel.send('Используйте: **!править <match_id> <победа|проигрыш|ничья>**');
    }
    const r = await sbService(`matches?select=id&id=eq.${id}`);
    if (!r || !r.length) return channel.send('Матч не найден.');
    await sbService('matches', 'PATCH', { id, result, team_score: 0 });
    await sbService(`match_stats?match_id=eq.${id}`, 'PATCH', { confirmed: true });
    return channel.send(`✅ Матч \`${id}\` исправлен: ${result}, подтверждено.`);
  }

  if (cmd === 'статистика') {
    const e = embed({ title: '📊 Статистика недели (B0)', description: `Матчей собрано: ${statState.matches}\nНе распознано: ${statState.parseFail}` });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'события') {
    const ev = await fetchEvents();
    const e = embed({ title: '📅 События кланов', description: ev.map(v => `🗓 **${v.title}** (${new Date(v.starts_at).toLocaleString('ru')})`).join('\n') || 'Событий нет.' });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'таблицы' || cmd === 'matches') {
    const m = await fetchMatches();
    const e = embed({ title: '🏆 Таблица матчей', description: m.map(x => `- ${x.played_at ? new Date(x.played_at).toLocaleDateString('ru') : '—'} · ${x.mode || 'без режима'} · ${x.result || '—'} · место ${x.place || '—'}${x.extra && x.extra.source ? ` · источник: ${x.extra.source}` : ''}`).join('\n') || 'Матчей нет.' });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'профиль' || cmd === 'clan-profile') {
    const q = args.join(' ').trim();
    const found = await fetchClansByName(q);
    if (!found.length) return channel.send('Клан "' + escArg(q) + '" не найден.');
    const c = found[0];
    const stats = await fetchLeaderboardForClan(c.id);
    const e = embed({ title: `🏰 Профиль клана — ${escArg(c.name)}`, description: `Мин. опыт: ${c.min_gear_level || '?'}${c.about ? '\n📝 ' + escArg(c.about) : ''}\n\n**Топ-игроки:**\n` + stats.slice(0, 10).map((s, i) => `${i + 1}. **#${s.player_id}** — ${s.kills}K / ${s.deaths}D`).join('\n') });
    return channel.send({ embeds: [e] });
  }

  if (cmd === 'принять' || cmd === 'reject' || cmd === 'отклонить') {
    const id = args[0];
    const accept = cmd === 'принять' || cmd === 'accept';
    if (!id) return channel.send('Используйте: **!принять <app_id>** или **!отклонить <app_id>**');
    const r = await sbService('rpc/decide_application', 'POST', { aid: id, accept });
    if (r && r.error) return channel.send('❌ ' + r.error.message);
    await sbService(`clan_applications?id=eq.${id}`, 'PATCH', { [`discord_${accept ? 'accepted' : 'rejected'}_at`]: new Date().toISOString() });
    return channel.send(accept ? `✅ Заявка ${id} принята.` : `🚫 Заявка ${id} отклонена.`);
  }

function escArg(s) {
  const r = require('discord.js').escapeMarkdown ? require('discord.js').escapeMarkdown(String(s || '')) : String(s || '');
  return r.slice(0, 200);
}

return channel.send(`Неизвестная команда: \`${cmd}\`. Напишите \`!help\`.`);
}

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
] });
clientRef = client;

// Slash-команды не требуют привилегированного Message Content Intent.
const SLASH_COMMANDS = [
  { name: 'help', description: 'Справка по командам' },
  { name: 'debug', description: 'Диагностика доступа к Supabase' },
  { name: 'clans', description: 'Список кланов' },
  { name: 'zone', description: 'Активные задания / зона' },
  { name: 'stats', description: 'Общая статистика площадки' },
  { name: 'tactics', description: 'Галерея тактик' },
  { name: 'link', description: 'Привязать этот канал к клану с сайта', options: [
    { name: 'clan', description: 'Название клана с сайта', type: 3, required: true },
    { name: 'channel_id', description: 'ID канала (по умолчанию — текущий)', type: 3, required: false },
  ] },
  { name: 'match', description: 'Начать сбор матча по скриншоту' },
  { name: 'apps', description: 'Заявки в кланы' },
  { name: 'rating', description: 'Топ игроков клана' },
  { name: 'search', description: 'Поиск клана', options: [{ name: 'query', description: 'Название клана', type: 3, required: true }] },
  { name: 'contact', description: 'Найти клан по нику игрока', options: [{ name: 'nick', description: 'Ник игрока', type: 3, required: true }] },
  { name: 'unconfirmed', description: 'Матчи без подтверждённой статистики' },
  { name: 'fix', description: 'Исправить результат матча', options: [
    { name: 'match_id', description: 'ID матча', type: 3, required: true },
    { name: 'result', description: 'победа / проигрыш / ничья', type: 3, required: true },
  ] },
  { name: 'week', description: 'Статистика недели' },
  { name: 'events', description: 'События кланов' },
  { name: 'matches', description: 'Таблица матчей' },
  { name: 'profile', description: 'Профиль клана', options: [{ name: 'clan', description: 'Название клана', type: 3, required: true }] },
  { name: 'decide', description: 'Принять или отклонить заявку', options: [
    { name: 'app_id', description: 'ID заявки', type: 3, required: true },
    { name: 'accept', description: 'true = принять, false = отклонить', type: 5, required: true },
  ] },
];
const SLASH_MAP = {
  help: 'help', debug: 'debug', clans: 'кланы', zone: 'зона', stats: 'стат', tactics: 'тактики',
  link: 'чат', match: 'матч', apps: 'заявки', rating: 'рейтинг', search: 'поиск',
  contact: 'контакт', unconfirmed: 'неподтверждено', fix: 'править', week: 'статистика',
  events: 'события', matches: 'таблицы', profile: 'профиль',
};

// Глобальные команды Discord может кэшировать до часа. Дополнительно регистрируем
// их в каждом сервере — guild-команды появляются сразу.
let registrationState = null;
async function registerSlashCommands() {
  if (!client.application) return;
  const result = { at: new Date().toISOString(), global: null, guilds: {}, error: null, names: SLASH_COMMANDS.map(c => c.name) };
  try {
    const globalCmds = await client.application.commands.set(SLASH_COMMANDS);
    result.global = globalCmds.size;
    console.log('Slash-команды зарегистрированы глобально:', globalCmds.size);
  } catch (e) {
    result.error = 'global: ' + e.message;
    console.error('Глобальная регистрация slash-команд не удалась:', e.message);
  }
  for (const guild of client.guilds.cache.values()) {
    try {
      const guildCmds = await guild.commands.set(SLASH_COMMANDS);
      result.guilds[guild.id] = { name: guild.name, count: guildCmds.size };
      console.log(`Slash-команды зарегистрированы в сервере «${guild.name}» (${guild.id}):`, guildCmds.size);
    } catch (e) {
      result.guilds[guild.id] = { name: guild.name, error: e.message };
      console.error(`Slash-команды НЕ зарегистрированы в сервере «${guild.name}» (${guild.id}):`, e.message);
    }
  }
  registrationState = result;
  runtimeStatus.commands = result;
  runtimeStatus.lastError = result.error;
}

client.on('guildCreate', async guild => {
  console.log(`Бот добавлен на сервер «${guild.name}» (${guild.id})`);
  runtimeStatus.guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
  try {
    const cmds = await guild.commands.set(SLASH_COMMANDS);
    console.log(`Slash-команды зарегистрированы в сервере «${guild.name}»:`, cmds.size);
    if (registrationState) registrationState.guilds[guild.id] = { name: guild.name, count: cmds.size };
    runtimeStatus.commands = registrationState;
  } catch (e) {
    console.error(`Slash-команды НЕ зарегистрированы в сервере «${guild.name}»:`, e.message);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  // Discord ждёт ответа максимум 3 секунды — сразу откладываем и отвечаем редактированием.
  await interaction.deferReply().catch(() => {});
  const name = interaction.commandName;
  const cmd = name === 'decide' ? (interaction.options.getBoolean('accept') ? 'принять' : 'отклонить') : (SLASH_MAP[name] || name);
  const args = [];
  for (const o of interaction.options.data) {
    if (o.name === 'accept') continue;
    args.push(String(o.value));
  }
  const fake = {
    channel: { send: async payload => interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload) },
    author: { id: interaction.user.id },
    channelId: interaction.channelId,
  };
  try { await handleCommand(cmd, fake, args); }
  catch (e) {
    console.error('Slash command failed', name, e);
    const text = '❌ ' + e.message;
    if (interaction.deferred) await interaction.editReply(text).catch(() => {}); else await interaction.reply(text).catch(() => {});
  }
});

// ── Автосбор статистики матчей (турнир-стадия) ──────────────────────────
// Команда: !матч → бот ожидает скриншот → бот спрашивает стадию (1/2/3) и результат → создаёт матч на сайте.
const matchCollect = new Map(); // userId → {stage:null,result:null,screenshot:null}
const dumpCmdHelper = async (cmd, args, message) => {
  try { await handleCommand(cmd, message, args); } catch (e) { await message.reply('❌ ' + e.message); }
};
client.on('messageUpdate', async () => {});

client.on('clientReady', async () => {
  console.log('Бот ' + client.user.tag + ' готов · commit ' + COMMIT);
  runtimeStatus.ready = true;
  runtimeStatus.botTag = client.user.tag;
  runtimeStatus.guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
  console.log('Серверы бота:', runtimeStatus.guilds.map(g => `${g.name} (${g.id})`).join(', ') || 'бот не добавлен ни на один сервер');
  if (!client.guilds.cache.size) {
    console.log('Пригласите бота: https://discord.com/oauth2/authorize?client_id=' + (client.application && client.application.id) + '&permissions=248832&scope=bot%20applications.commands');
  }
  await registerSlashCommands();

  // Рассылка активных заданий раз в 6 часов
  setInterval(async () => {
    const ch = client.channels.cache.get(config.announcementsChannel);
    if (!ch || !(ch instanceof TextChannel)) return;
    const games = await fetchActiveGames();
    if (!games.length) return;
    const e = embed({
      title: '⚡ ClanPulse — задания',
      description: games.map((t) => `- **${t.title}** — ${new Date(t.starts_at).toLocaleString('ru')}`).join('\n'),
    });
    await ch.send({ embeds: [e], allowedMentions: { parse: ['everyone'] } });
  }, 6 * 3600 * 1000);
  // Посты событий/турниров в привязанные каналы раз в 6 часов
  setInterval(postEventsDigest, 6 * 3600 * 1000);
  postEventsDigest();
  // Оптимистичная статистика + разбор нераспознанных раз в 7 дней
  setInterval(async () => { await gatherStats(); await statDigest(); await repostUnrecognizedDigest(); }, 7 * 24 * 3600 * 1000);
  setTimeout(async () => { await gatherStats(); await statDigest(); await repostUnrecognizedDigest(); }, 7 * 24 * 3600 * 1000);
});

// ── Мост двунаправленного чата ────────────────────────────────────────────
// Сайт → Discord: сообщения каналов (source='site') постятся в Дискорд.
// Дискорд → сайт: сообщения из привязанных каналов вставляются в clan_messages (source='discord').

// ── Мост двунаправленного чата + синхронизация заявок ──────────────────
const bridgeState = { apps: {}, seenMsgIds: {} };
function loadBridgeState() {
  try {
    const s = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'bridge_state.json'), 'utf8'));
    if (s && s.apps) Object.assign(bridgeState.apps, s.apps);
    if (s && s.seenMsgIds) Object.assign(bridgeState.seenMsgIds, s.seenMsgIds);
  } catch {}
}
function saveBridgeState() {
  try { require('fs').writeFileSync(require('path').join(__dirname, 'bridge_state.json'), JSON.stringify(bridgeState)); } catch {}
}
loadBridgeState();

async function bridgePoll() {
  const links = await fetchChannelLinks();
  if (!links.length) return;
  const byChannel = new Map(links.map((l) => [l.channel_id, l]));
  const chanIds = [...byChannel.keys()];

  // Сайт → Discord
  // Заявки: новые записи clan_applications — постим в канал
  const appsR = await sbService('clan_applications?select=id,clan_name,status,created_at&order=created_at.desc&limit=50');
  if (Array.isArray(appsR)) {
    for (const app of appsR) {
      if (app.status !== 'pending' && !bridgeState.apps[app.id]) {
        // решенные везде — одомашниваем, чтобы не спамить
        bridgeState.apps[app.id] = app.status;
        continue;
      }
      const seen = bridgeState.apps[app.id] || 'missing';
      if (app.status !== seen) {
        bridgeState.apps[app.id] = app.status;
        if (chanIds.length) {
          const link = links.find(l => l.name === app.clan_name) || links[0];
          await postToDiscord(link.channel_id, `📋 **Заявка ${app.id}** — ${app.clan_name} (${app.status})`);
        }
      }
    }
    saveBridgeState();
  }

  const messages = await fetchUnpostedSiteMessages(links.map((l) => l.channel_id));
  for (const m of messages) {
    const link = byChannel.get(m.channel_id) || links[0];
    const chanId = link && link.channel_id;
    if (!chanId) continue;
    const msg = await postToDiscord(chanId, `[Сайт] ${m.body}`);
    if (msg && msg.id) {
      await sbService(`clan_messages?id=eq.${m.id}`, 'PATCH', { source: 'site_posted', discord_msg_id: msg.id });
    }
  }

  // Дискорд → сайт (сообщения в привязанных каналах → clan_messages)
  if (chanIds.length) {
    const linksArr = await sbGet('clan_channels?order=created_at.asc');
    for (const link of linksArr) {
      const r2 = await fetch(`https://discord.com/api/v10/channels/${link.channel_id}/messages?limit=20`, {
        headers: { Authorization: 'Bot ' + config.botToken },
      });
      const list = await r2.json().catch(() => []);
      if (!Array.isArray(list)) continue;
      for (const dm of list) {
        if (!dm.author || dm.author.bot) continue;
        const body = String(dm.content || '').trim();
        if (!body) continue;
        await sbService('clan_messages', 'POST', {
          clan_id: link.clan_id || null, user_id: null, body, source: 'discord', channel_id: link.channel_id, discord_msg_id: dm.id,
        });
      }
    }
  }
}

setInterval(bridgePoll, 30 * 1000);

// Завершение сбора матча — создаём запись на сайте через service_role
// Скачиваем скриншот Discord → base64
async function downloadAsBase64(url) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString('base64');
}
// Вызываем edge-функцию parse-battle как на сайте (сама распознаёт скриншот)
// Если первая модель (edge-функция) ошибается/перегружена — пробуем вторую из ENV,
// если нет — повторяем опрос после 1.5 сек (делаем до 3 попыток).
async function parseMatchFromScreenshot(clanId, base64, attempts = 3) {
  const endpoints = [`${SB.base}/functions/v1/parse-battle`, process.env.PARSE_BATTLE_FALLBACK_URL].filter(Boolean);
  const key = process.env.SUPABASE_ANON_KEY;
  for (const url of endpoints) {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { apikey: key } : {}) },
          body: JSON.stringify({ clan_id: clanId, image: base64, mime: 'image/jpeg' }),
        });
        const j = await r.json().catch(() => null);
        if (j && !j.error) return j;
        console.error('parse-battle error:', r.status, j && j.error);
      } catch (e) {
        console.error('parse-battle failed:', e.message);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}
// Заполняем match_stats из распознанного (parsed.players)
async function saveMatchStats(matchId, clanId, parsed) {
  if (!parsed || !Array.isArray(parsed.players)) return null;
  return sbService('match_stats', 'POST', parsed.players.map(p => ({
    match_id: matchId, clan_id: clanId, nick_raw: p.nick,
    kills: p.kills || 0, deaths: p.deaths || 0, assists: p.assists || 0, score: p.score || 0, confirmed: true,
  })));
}

async function finishMatchCollect(message) {
  const st = matchCollect.get(message.author.id) || {};
  matchCollect.delete(message.author.id);
  if (!st.stage && st.result) return message.reply('Нужна хотя бы стадия (1/2/3).');
  const members = await sbService('clan_members?select=clan_id&limit=1');
  const fallback = await sbService('clans?select=id&limit=1');
  const clanId = (members && members[0] && members[0].clan_id) || (fallback && fallback[0] && fallback[0].id);
  if (!clanId) return message.reply('Клан не найден — создайте клан на сайте.');
  const clan = { id: clanId };
  let parsed = null;
  const row = {
    clan_id: clan.id,
    played_at: new Date().toISOString(),
    result: st.result || 'Победа',
    team_score: 0,
    extra: { source: 'discord', stage: st.stage, screenshot: st.screenshot },
    created_at: new Date().toISOString(),
  };
  if (st.screenshot) {
    await message.reply('🔍 Распознаю скриншот…');
    try {
      parsed = await parseMatchFromScreenshot(clan.id, await downloadAsBase64(st.screenshot));
      if (!parsed) {
        statState.parseFail = (statState.parseFail || 0) + 1;
        saveBridgeState();
        return message.reply('❌ Распознать скриншот не удалось — создать матч невозможно (проблема с моделью распознавания, повторите позже).');
      }
      if (!row.result && parsed.result) row.result = parsed.result;
      row.team_score = parsed.team_score || row.team_score;
      row.extra.place = parsed.place;
      row.mode = parsed.mode;
    } catch (e) {
      await message.reply('⚠️ Ошибка распознавания: ' + e.message);
      return;
    }
  }
  const r = await sbService('matches', 'POST', row);
  if (r && r.error) return message.reply('❌ ' + r.error.message);
  const mid = (r && r.id) || null;
  if (parsed && mid) await saveMatchStats(mid, clan.id, parsed);
  await message.reply(`✅ Матч создан${mid ? ': ' + mid : ''}${parsed && parsed.players && parsed.players.length ? ` + статистика: ${parsed.players.length} игроков` : ''}. Посмотрите на сайте — во вкладке «Аналитика»/«История».`);
  saveBridgeState();
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── Автосбор матча: числа 1/2/3 сразу записывают стадию ──
  const pendingMatch = matchCollect.get(message.author.id);
  if (pendingMatch && message.content.match(/^[123]$/)) {
    pendingMatch.stage = Number(message.content[0]);
    await message.channel.send(`✅ Стадия **${pendingMatch.stage}**. Пиши: **победа / проигрыш / ничья** — матч создастся только после успешного распознания скриншота.`);
    return;
  }
  if (pendingMatch && /^(победа|побед)$/i.test(message.content.trim())) {
    pendingMatch.result = 'победа';
    await finishMatchCollect(message);
    return;
  }
  if (pendingMatch && /^(проигрыш|поражение|пораж)$/i.test(message.content.trim())) {
    pendingMatch.result = 'поражение';
    await finishMatchCollect(message);
    return;
  }
  if (pendingMatch && /^(ничья|твилт)$/i.test(message.content.trim())) {
    pendingMatch.result = 'ничья';
    await finishMatchCollect(message);
    return;
  }
  if (pendingMatch && !message.content.startsWith('!') && message.attachments && message.attachments.size) {
    const [att] = [...message.attachments.values()];
    if (att && att.contentType && /^image\//i.test(att.contentType)) {
      pendingMatch.screenshot = att.url;
      await message.channel.send('📸 Скриншот получен. Напиши **стадия: 1/2/3**.');
      if (!pendingMatch.stage) return;
    }
  }

  // ── Дискорд → сайт (ручное отображение) ──
  try {
    const links = await fetchChannelLinks();
    const chanId = message.channelId || message.channel.id;
    const link = links.find((l) => l.channel_id === chanId);
    if (link && message.content && !message.content.startsWith('!')) {
      await sbService('clan_messages', 'POST', {
        user_id: null, body: message.content, source: 'discord', channel_id: chanId, discord_msg_id: message.id,
      });
    }
  } catch (e) { /* проглочено, не важно для клиента */ }
  const text = message.content.trim();
  if (!text.startsWith('!')) return;
  const parts = text.slice(1).trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);
  try {
    await handleCommand(cmd, message, args);
  } catch (e) {
    await message.reply('❌ Ошибка: ' + e.message);
  }
});

if (!config.botToken) {
  console.error('BOT_TOKEN is not set — Discord login skipped; health server is still up.');
} else {
  client.login(config.botToken).catch(e => console.error('Discord login failed:', e.message));
}
