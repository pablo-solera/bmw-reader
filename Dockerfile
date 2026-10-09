FROM oven/bun:1.4-alpine AS base
WORKDIR /app

FROM base AS core
COPY --from=reader_core /package.json /bun.lock /tsconfig.json /tsconfig.build.json ./reader-core/
COPY --from=reader_core /contract ./reader-core/contract
COPY --from=reader_core /src ./reader-core/src
COPY --from=reader_core /docs ./reader-core/docs
WORKDIR /app/reader-core
RUN bun install --frozen-lockfile && bun run build

FROM base AS install
COPY --from=reader_core /package.json /bun.lock ./reader-core/
COPY --from=core /app/reader-core/dist ./reader-core/dist
WORKDIR /app/bmw-reader
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
ENV NODE_ENV=production
COPY --from=reader_core /package.json ./reader-core/package.json
COPY --from=core /app/reader-core/dist ./reader-core/dist
COPY --from=install /app/bmw-reader/node_modules ./node_modules
WORKDIR /app/bmw-reader
COPY package.json bun.lock ./
COPY src ./src
USER bun
EXPOSE 3004
CMD ["bun", "src/index.ts"]
