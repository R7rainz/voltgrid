# VoltGrid Dashboard

Browser-based operator dashboard and charger simulator for the VoltGrid CSMS.

## Run

Start the backend first:

```sh
cd ../csms
bun run dev
```

Then start the dashboard in another terminal:

```sh
bun install
bun run dev
```

Open http://localhost:9000, add a simulated charger, and choose **Run full
demo**. The browser sends OCPP-style WebSocket messages to the Hono backend,
which persists the session, meter readings, and invoice in PostgreSQL.

The simulator cards are local to the open browser tab. A refresh clears the
cards, but it does not remove the persisted backend records.

Optional URLs:

```env
NEXT_PUBLIC_CSMS_HTTP_URL=http://localhost:6773
NEXT_PUBLIC_CSMS_WS_URL=ws://localhost:6773
```
