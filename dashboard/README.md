# VoltGrid Dashboard

Browser-based operator dashboard and charger simulator for the VoltGrid CSMS.

## Run with Docker Compose

From the repository root, start the complete VoltGrid stack with one command:

```sh
docker compose up --build -d
```

Open http://localhost:9000, add a simulated charger, and choose **Run full
demo**. The browser sends OCPP-style WebSocket messages to the Hono backend,
which persists the session, meter readings, and invoice in PostgreSQL.

## Optional local development

When working on the dashboard alone, install dependencies and run it locally.
The CSMS and PostgreSQL must already be available.

```sh
bun install
bun run dev
```

The simulator cards are local to the open browser tab. A refresh clears the
cards, but it does not remove the persisted backend records.

Optional URLs:

```env
NEXT_PUBLIC_CSMS_HTTP_URL=http://localhost:6773
NEXT_PUBLIC_CSMS_WS_URL=ws://localhost:6773
```
