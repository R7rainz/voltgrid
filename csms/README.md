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
It exits with a non-zero status when the connection, protocol flow, or invoice
verification fails. `CSMS_HTTP_URL`, `CSMS_WS_URL`, `CHARGER_ID`, `ID_TAG`,
`CONNECTOR_ID`, `SIMULATOR_POWER_KW`, and `SIMULATOR_TIMEOUT_MS` can be
overridden for automated checks.

The WebSocket endpoint is:

```text
ws://localhost:6773/ocpp/<charger-id>
```

The CSMS calls `POST http://localhost:8787/v1/allocate` after accepted session
start and stop events. It applies each returned allocation to a connected
simulator with an outbound charging-profile command. If the Go service or a
charger is unavailable, the charging session remains the source-of-truth
operation and the allocation failure is logged.

The live policy is selected from the dashboard. The available policies are
`demand-weighted` (default), `equal-share`, `fcfs`, and
`deadline-aware`. A policy switch sends zero-power profiles first, pauses
briefly, then applies the new per-charger profiles. The deadline-aware policy
uses the vehicle's remaining energy, departure window, and priority. The
dashboard shows the selected policy, requested, allocated, unmet power, and
allocation reason for each vehicle.
