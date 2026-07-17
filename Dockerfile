FROM node:18-alpine
WORKDIR /app
COPY railway-bot/package*.json ./
RUN npm install
COPY railway-bot/ .
RUN npm run build
CMD ["npm", "start"]
