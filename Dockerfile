FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV PORT=8080 DB_FILE=/data/sexyselectie.db
EXPOSE 8080
CMD ["node", "--no-warnings", "server/index.js"]
