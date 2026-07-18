FROM node:18-alpine
WORKDIR /app
COPY railway-bot/package.json ./
RUN npm install --no-package-lock
COPY railway-bot/dist ./dist
CMD ["node", "dist/bot.js"]
