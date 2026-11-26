FROM node:20-alpine
WORKDIR /app

# Работает и когда build context = корень репозитория, и когда = discord-bot/
COPY . /src
RUN if [ -f /src/discord-bot/package.json ]; then \
      cp /src/discord-bot/package*.json /app/ && cp /src/discord-bot/bot.js /app/; \
    else \
      cp /src/package*.json /app/ && cp /src/bot.js /app/; \
    fi

RUN npm install --omit=dev
ENV PORT=10000
EXPOSE 10000
CMD ["node", "bot.js"]
