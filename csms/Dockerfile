FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

ENV NODE_ENV=production
ENV PORT=6773

EXPOSE 6773

CMD ["bun", "run", "container:start"]
