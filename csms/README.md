## Run with Docker Compose

From the repository root, start the complete VoltGrid stack with one command:

```sh
docker compose up --build -d
```

This starts PostgreSQL, the CSMS, the Go load balancer, and the dashboard. The
CSMS runs on http://localhost:6773.

## Optional local development

To run only the CSMS without Docker, install dependencies and create `.env`
from `.env.example`. Set `DATABASE_URL` to a PostgreSQL/Neon connection string
and keep the Go service available at `http://localhost:8787`.

```sh
bun install
bun run dev
```

To simulate one complete charger session:
```sh
bun run simulate:charger
```

The simulator sends BootNotification, status updates, StartTransaction,
MeterValues, and StopTransaction, then fetches the generated invoice.

The WebSocket endpoint is:

```text
ws://localhost:6773/ocpp/<charger-id>
```

The CSMS calls `POST http://localhost:8787/v1/allocate` after accepted session
start and stop events. It applies each returned allocation to a connected
simulator with an outbound charging-profile command. If the Go service or a
charger is unavailable, the charging session remains the source-of-truth
operation and the allocation failure is logged.
