FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json ./

RUN npm run build

ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
