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

The dashboard's Grid Operations Lab uses the same CSMS boundary for a
stateless policy comparison:

~~~text
Next.js /lab
     │ POST /api/simulation/compare
     ▼
Hono CSMS :6773
     │ POST /v1/compare
     ▼
Go policy evaluator :8787
~~~

## Backend responsibilities

### Hono CSMS

- Accepts charger WebSocket connections at `/ocpp/:chargerId`.
- Validates the OCPP-style message envelope and supported payload fields.
- Persists chargers, connectors, OCPP messages, sessions, meter readings, and
  invoices through the Prisma contract.
- Exposes `GET /api/chargers`, `GET /api/chargers/:chargerId/black-box`, and
  `GET /api/sessions/:transactionId/invoice` for the dashboard.
- Calls the Go allocator after an accepted `StartTransaction` and
  `StopTransaction`.
- Sends the returned allocation to connected simulators through an outbound
  charging-profile command and tracks the latest applied value in process
  memory.
- On a connector fault, targets a 0 kW profile and waits for its acknowledgement
  before raising any healthy charger's limit; rejects meter increments while
  the connector is faulted. The Black Box endpoint reads the latest fault's
  status/profile events without exposing a replay-as-control operation.

### PostgreSQL/Neon

PostgreSQL is the durable source of truth. It stores business history that must
survive a process restart: charger identity, connector status, OCPP messages,
charging sessions, meter readings, and invoices.
Acknowledged outbound charging profiles are also stored as OCPP messages so
operators can review the fault and recovery sequence after the simulation.

### Go load balancer

The Go service is intentionally stateless. Hono sends the site power limit and
the currently active chargers. The service returns a fair allocation where the
sum never exceeds the site limit.

The browser simulator sends each car's requested power through a VoltGrid
`DataTransfer` message before starting a session. Hono uses that request for
allocation; `CHARGER_MAX_POWER_KW` is only a fallback for chargers that do not
send one. Changing the car's request while charging triggers a rebalance.

The Go policy evaluator exposes POST /v1/compare for the Grid Operations Lab.
It receives one time-series station scenario and evaluates
first-come-first-served, equal-share water-filling, and deadline-aware weighted
sharing. It returns per-step allocations, deadline shortfall, peak site import,
modeled cost, fairness, and plain-language allocation reasons. It remains
stateless and does not read PostgreSQL or speak OCPP.

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
