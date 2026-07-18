FROM node:18-alpine
WORKDIR /app
COPY railway-bot/package*.json ./
RUN npm install --omit=dev
COPY railway-bot/dist ./dist
CMD ["node", "dist/bot.js"]
