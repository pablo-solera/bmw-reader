FROM oven/bun:1.4.2-alpine AS base
WORKDIR /app

FROM base AS install
WORKDIR /app/bmw-reader
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
ENV NODE_ENV=production
COPY --from=install /app/bmw-reader/node_modules /app/bmw-reader/node_modules
WORKDIR /app/bmw-reader
COPY package.json bun.lock ./
COPY src ./src
USER bun
EXPOSE 3004
CMD ["bun", "src/index.ts"]
