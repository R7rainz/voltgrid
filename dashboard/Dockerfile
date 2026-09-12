FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV NEXT_PUBLIC_CSMS_HTTP_URL=http://localhost:6773
ENV NEXT_PUBLIC_CSMS_WS_URL=ws://localhost:6773

RUN bun run build

EXPOSE 9000

CMD ["bun", "run", "start"]
