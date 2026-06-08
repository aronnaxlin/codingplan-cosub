# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/ ./server/
COPY --from=builder /app/dist/ ./dist/
RUN mkdir -p /app/data
ENV PORT=8787
ENV DATA_FILE=./data/store.json
EXPOSE 8787
CMD ["node", "server/index.js"]
