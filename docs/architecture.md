# VoltGrid architecture

## Runtime flow

```text
Next.js dashboard :9000
        │
        ├─ HTTP: charger state and invoice reads
        └─ WebSocket: OCPP-style charger traffic
                         │
                         ▼
                 Hono CSMS :6773
                   │       │
                   │       └─ PostgreSQL/Neon
                   │          durable source of truth
                   │
                   └─ HTTP JSON: POST /v1/allocate
                              │
                              ▼
                    Go load balancer :8787
```

## Backend responsibilities

### Hono CSMS

- Accepts charger WebSocket connections at `/ocpp/:chargerId`.
- Validates the OCPP-style message envelope and supported payload fields.
- Persists chargers, connectors, OCPP messages, sessions, meter readings, and
  invoices through the Prisma contract.
- Exposes `GET /api/chargers` and
  `GET /api/sessions/:transactionId/invoice` for the dashboard.
- Calls the Go allocator after an accepted `StartTransaction` and
  `StopTransaction`.
- Sends the returned allocation to connected simulators through an outbound
  charging-profile command and tracks the latest applied value in process
  memory.

### PostgreSQL/Neon

PostgreSQL is the durable source of truth. It stores business history that must
survive a process restart: charger identity, connector status, OCPP messages,
charging sessions, meter readings, and invoices.

### Go load balancer

The Go service is intentionally stateless. Hono sends the site power limit and
the currently active chargers. The service returns a fair allocation where the
sum never exceeds the site limit.

For the current demo, each active charger uses the configured
`CHARGER_MAX_POWER_KW` value as both its requested and maximum power. Per-charger
power settings can be added to the schema and dashboard later.

### Redis

Redis is reserved for transient live state and event distribution. It is not
part of the current working path, so PostgreSQL and the in-process state map
remain the current implementation.

## Current integration boundary

The Hono backend is connected to the Go decision endpoint and applies the
returned allocation to connected browser simulators through an outbound
charging-profile command. The simulator acknowledges the command and shows the
applied limit on the dashboard. This is a software demonstration of the
control loop; it does not control physical electrical hardware.
