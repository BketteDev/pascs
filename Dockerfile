# The game server (static client + 128 Hz WebSocket game). Game assets are not in the image: mount them (see docker-compose.yml).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY server ./server
COPY public ./public
ENV PORT=6767
EXPOSE 6767
CMD ["node", "server.mjs"]
