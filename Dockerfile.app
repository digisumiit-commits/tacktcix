FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm ci

COPY src/ src/
RUN npx tsc

FROM node:22-alpine AS runner

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY migrations/ migrations/

EXPOSE 3100

CMD ["node", "dist/main.js"]
