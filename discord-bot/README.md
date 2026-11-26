# ClanPulse Discord bot

Бот в Дискорде для кланов: справочник кланов, задания/турниры, статистика площадки, тактики, мост с сайтом и автосбор матчей по скриншотам. Данные берутся из Supabase по REST.

## Локальный запуск

```bash
npm install
cp .env.example .env     # заполнить .env
node bot.js              # или npm start
```

## Хостинг на Render.com

1. Залейте папку `discord-bot` в отдельный GitHub-репозиторий.
2. Render Dashboard → **New** → **Web Service** → выберите репозиторий.
3. Render сам видит `render.yaml`: `buildCommand: npm install`, `startCommand: node bot.js`.
4. В **Environment** заполните `BOT_TOKEN`, `SUPABASE_SERVICE_ROLE`, `CHANNEL_ID` (и при необходимости `PARSE_BATTLE_FALLBACK_URL`).
5. **Create Web Service**.
6. Пригласите бота по OAuth2-ссылке с областями **`bot`** и **`applications.commands`** (права `248832`). Привилегированные интенты не нужны — бот работает на slash-командах.

⚠️ Discord-бот — это **долгоживущий WebSocket-процесс**, а не веб-сервер. Render может «усыплять» free-веб-сервисы без входящих HTTP-запросов. Чтобы бот не отключался:
- включите **Auto-Deploy** и мониторинг;
- при первом деплое можно открыть `https://<service>.onrender.com` — он вернёт 404, это нормально;
- при Problems with sleeping — перейдите на платный план или VPS (Dockerfile готов).

## Переменные окружения

| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | Токен бота (Discord Developer Portal → Application → Bot → Reset Token) |
| `SUPABASE_SERVICE_ROLE` | Сервисный ключ Supabase — бот пишет `clan_channels`, `clan_messages`, `matches` и т.д. |
| `CHANNEL_ID` | Канал для рассылок заданий |
| `SUPABASE_URL` | Опционально, по умолчанию `https://jzfaggufycangmgwuuks.supabase.co` |
| `PARSE_BATTLE_FALLBACK_URL` | Резервный endpoint `parse-battle` при перегрузке основной модели |

## Команды

Все команды — slash-команды Discord (префикс `/`).

| Команда | Описание |
|---|---|
| `/help` | Справка |
| `/clans` | Список кланов |
| `/zone` | Активные задания и события |
| `/stats` | Статистика площадки |
| `/tactics` | Галерея тактик |
| `/rating` | Лидеры K/D клана |
| `/search <название>` | Поиск клана |
| `/contact <ник>` | Клан игрока |
| `/profile <название>` | Карточка клана и топ-игроки |
| `/events` | События кланов |
| `/matches` | Архив матчей |
| `/apps` | Заявки в кланы |
| `/decide <app_id> <accept>` | Принять или отклонить заявку |
| `/link <clan> [type] [channel_id]` | Привязать канал: `type=chat` — чат клана, `type=events` — события и задания (по умолчанию чат) |
| `/unlink [type] [channel_id]` | Отвязать канал от чата или от событий/заданий |
| `/match` | Автосбор: скриншот → стадия 1/2/3 → матч со статистикой |
| `/unconfirmed` | Матчи без подтверждённой статистики |
| `/fix <match_id> <result>` | Исправить матч и подтвердить |
| `/week` | Статистика недели |
| `/debug` | Диагностика доступа к Supabase |

Статус сервиса, список кланов и привязок: `https://<service>.onrender.com/status`.

Привязки хранятся в `clan_channels`: `name = chat::<клан>` для чата и `events::<клан>` для событий/заданий. Старые записи без префикса считаются чатом. Мост чата использует только привязки `chat`, рассылка событий — только `events` (пока привязки `events` нет, рассылка уходит в чат).

## Автоматика

- Каждые 30 сек — мост чата (сайт ⇄ Discord) и синхронизация заявок
- Каждые 6 часов — посты событий в привязанные каналы
- Раз в 7 дней — оптимистичная статистика и разбор нераспознанных скриншотов
