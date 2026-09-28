FROM oven/bun:1.3-alpine AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
ENV NODE_ENV=production
COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
USER bun
EXPOSE 3004
CMD ["bun", "src/index.ts"]
