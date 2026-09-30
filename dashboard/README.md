# VoltGrid Dashboard

Browser-based operator dashboard and charger simulator for the VoltGrid CSMS.

## Run with Docker Compose

From the repository root, start the complete VoltGrid stack with one command:

```sh
docker compose up --build -d
```

Open http://localhost:9000. Add three cars requesting `40 kW` each, connect
them, then press **Start** on each card. With a `100 kW` site limit, the Go
allocator gives them roughly `33.33 kW` each. Stop one session to see the two
remaining cars rise to `40 kW` each. You can change demand or site capacity
while sessions are active. **Run full demo** also sends meter readings and
generates an invoice; payment confirmation is a frontend mock.

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
