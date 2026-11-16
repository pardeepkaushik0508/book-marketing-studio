FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0
EXPOSE 3001
VOLUME ["/app/data"]
CMD ["node", "server.js"]
