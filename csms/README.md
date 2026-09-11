To install dependencies:
```sh
bun install
```

Create `.env` from `.env.example`, then set `DATABASE_URL` to the current
PostgreSQL/Neon connection string. For the smart-charging integration, keep the
Go service running at `http://localhost:8787` or configure `LOAD_BALANCER_URL`.

To run the CSMS:
```sh
bun run dev
```

The CSMS runs on http://localhost:6773.

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
start and stop events. If the Go service is unavailable, the charging session
still remains the source-of-truth operation and the allocation failure is
logged.
