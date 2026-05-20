FROM node:20-alpine

WORKDIR /app

# Install build dependencies if needed, curl for health check
RUN apk add --no-cache curl

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
