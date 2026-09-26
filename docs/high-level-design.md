# VoltGrid High-Level Design

## 1. Document purpose

This document describes the high-level design of VoltGrid, an EV Charging
Station Management System (CSMS). It is the architectural reference for the
capstone project, supervisor reviews, implementation decisions, and phase
demos.

VoltGrid is being built as a hardware-free system. Browser and CLI simulators
act as chargers, but the communication boundary is designed around the same
charger-to-CSMS flow that a physical charger would use.

### Design status

| Area | Status |
| --- | --- |
| Hono + Bun CSMS | Implemented in Phase 1 |
| OCPP-style WebSocket lifecycle | Implemented in Phase 1; exact OCPP version remains to be selected |
| PostgreSQL persistence through Prisma ORM Next | Implemented in Phase 1 |
| Next.js operator dashboard and charger simulator | Implemented in Phase 1 |
| Go load-balancer decision service | Implemented as a Phase 2 service |
| Applying calculated power limits through outbound charger messages | Phase 2 target/demo capability |
| Redis live-state and pub/sub layer | Planned; not required for the current demo |
| Physical charger control and payment settlement | Out of scope for v1 |

The words “implemented”, “target”, and “planned” in this document are
deliberate. VoltGrid must not claim physical control, production scale, or a
specific OCPP-version certification without separate validation.

## 2. Problem and objectives

Charging operators need one system to understand charger availability, manage
charging sessions, record energy, calculate charges, and observe station
health. A site also has a finite electrical capacity. If several vehicles
charge at once, their combined requested power can be greater than the site
limit.

VoltGrid addresses this with a central CSMS that:

1. Receives charger events over a persistent WebSocket connection.
2. Validates and persists operational and billing data.
3. Exposes station information to an operator dashboard.
4. Calculates a fair per-charger allocation for active sessions.
5. Sends the calculated limit back through the charger communication channel
   in the Phase 2 simulator demo.

### Primary objectives

- Demonstrate an end-to-end charger lifecycle without physical vehicle
  hardware.
- Preserve session, meter, message, and invoice history in PostgreSQL.
- Keep allocation decisions independent from the CSMS request-handling code.
- Guarantee that the sum of returned allocations does not exceed the
  configured site power limit.
- Keep the local setup free to run with Docker Compose.

### Non-objectives for v1

- Controlling a real charger or vehicle power electronics.
- Processing real payments or settlement with a payment gateway.
- Roaming between charging networks.
- Dynamic market pricing.
- Machine-learning-based charging optimization.
- Multi-region or high-availability production deployment.

## 3. Users and system actors

| Actor | Responsibility | Main interaction |
| --- | --- | --- |
| Operator | Configures a site, watches charger state, and reviews invoices | Next.js dashboard |
| Driver/session user | Starts and stops a charging session | Represented by simulator input and `idTag` in the demo |
| Charger | Reports boot, status, transaction, and meter events | OCPP-style WebSocket |
| CSMS | Coordinates communication, persistence, validation, billing, and allocation | Hono + Bun |
| Allocator | Calculates fair site-power distribution | Go HTTP service |
| Database | Stores durable operational history | PostgreSQL |

Authentication and role-based access are architectural extension points. The
current capstone demo uses a local operator workflow and should not be
presented as a production identity system.

## 4. System context

```text
                         VoltGrid system boundary

  Operator                                                         Charger
     │                                             physical or simulated client
     │ HTTP reads/writes + live dashboard updates                    │
     ▼                                                               │
┌──────────────────────┐       WebSocket/OCPP-style messages         │
│ Next.js dashboard    │◄────────────────────────────────────────────┘
│ :9000                 │
│ - operator controls   │
│ - charger cards      │
│ - browser simulator  │
└──────────┬───────────┘
           │ HTTP API
           ▼
┌────────────────────────────────────────────────────────────────────┐
│ Hono + Bun CSMS :6773                                               │
│ API routes · OCPP message handling · validation · sessions · billing │
│ live socket registry · Phase 2 rebalancing orchestration             │
└──────────────┬───────────────────────────────────────┬─────────────┘
               │ Prisma ORM Next                         │ JSON HTTP
               ▼                                         ▼
┌──────────────────────────────┐              ┌────────────────────────┐
│ PostgreSQL                    │              │ Go load balancer :8787 │
│ durable source of truth      │              │ stateless allocator    │
└──────────────────────────────┘              └────────────────────────┘

Redis is a future transient-state/pub-sub option and is not on the current
critical path.
```

The system boundary is intentionally small. The dashboard does not write
directly to PostgreSQL, the Go service does not access PostgreSQL, and the Go
service does not speak OCPP. The CSMS is the coordination boundary between all
three concerns.

## 5. Component design

### 5.1 Next.js dashboard

The dashboard is the operator-facing web application and the repeatable demo
client. It provides:

- A card for each simulated charger/vehicle in the current browser tab.
- Connect, start, meter-value, stop, disconnect, and full-demo controls.
- Live charger and connector state.
- Site power-limit and tariff settings.
- Session transaction IDs and generated invoices.
- Applied/projected charging power for the Phase 2 simulator flow.

The cards are local browser state. Refreshing the page clears the cards, while
records already accepted by the CSMS remain in PostgreSQL.

### 5.2 Hono + Bun CSMS

The CSMS is the system coordinator. It owns:

- HTTP routes used by the dashboard.
- The `/ocpp/:chargerId` WebSocket endpoint.
- OCPP-style envelope and payload validation.
- Charger registration and connector state updates.
- Charging-session state transitions.
- Meter-reading persistence.
- Invoice calculation using the configured energy tariff.
- The live charger socket registry used for the running process.
- Calls to the Go allocator when the active charging set changes.

The CSMS is deliberately split into app setup, routes, database access,
charger state, socket connections, and load-balancer integration. `index.ts`
only wires the server adapter and port.

### 5.3 PostgreSQL + Prisma ORM Next

PostgreSQL is the durable source of truth. It stores data that must survive a
CSMS restart:

- `Site`: station identity, power limit, and tariff.
- `Charger`: charge-point identity, site relation, connection metadata, and
  last-seen time.
- `Connector`: connector number, availability, and error code.
- `OcppMessage`: inbound message traceability and duplicate protection.
- `ChargingSession`: transaction lifecycle and meter boundaries.
- `MeterReading`: cumulative energy readings for a session.
- `Invoice`: tariff snapshot, energy, amount, currency, and status.

The database owns durable truth. In-process state is an optimization for the
single-process demo, not a replacement for the database.

### 5.4 Go load balancer

The Go service is a stateless decision service. It receives a site capacity and
the active chargers’ requested and maximum power. It returns one allocation
per charger and the calculated total.

The service does not:

- Read PostgreSQL.
- Own session state.
- Maintain WebSocket connections.
- Send charger messages.

Keeping those responsibilities in Hono makes the allocator easy to test as a
pure capacity decision component.

### 5.5 Redis

Redis is reserved for a later deployment shape where more than one CSMS
process needs shared live state or event fan-out. The current local demo uses
an in-memory socket/state map because it has no external service cost and does
not need cross-process coordination.

## 6. Communication interfaces

### 6.1 Charger WebSocket boundary

The endpoint is:

```text
ws://<csms-host>:6773/ocpp/<charger-id>
```

The message envelope is kept version-neutral until the project selects an
OCPP version. The conceptual forms are:

```text
Call:       [2, uniqueId, action, payload]
CallResult: [3, uniqueId, payload]
CallError:  [4, uniqueId, errorCode, errorDescription, details]
```

The Phase 1 charger flow is:

```text
Charger                  CSMS                         PostgreSQL
   │                       │                              │
   │── BootNotification ──►│                              │
   │                       │── charger/site upsert ──────►│
   │◄──── Accepted ────────│                              │
   │── StatusNotification ─►│                              │
   │                       │── connector/message record ─►│
   │── StartTransaction ───►│                              │
   │                       │── session + message record ──►│
   │◄──── transactionId ────│                              │
   │── MeterValues ────────►│── meter reading ────────────►│
   │── StopTransaction ────►│── close session + invoice ──►│
   │◄──── Accepted ──────────│                              │
```

The exact payload schema and accepted actions are implementation concerns of
the CSMS validation layer. A physical charger must be tested separately before
claiming interoperability.

### 6.2 Dashboard HTTP and live-update boundary

The dashboard uses the CSMS for both control and read operations. The current
surface includes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` or `/healthz` | CSMS health check |
| `GET` | `/api/chargers` | Read persisted charger summaries |
| `GET` | `/api/site` | Read current site configuration |
| `PATCH` | `/api/site` | Update site power limit and tariff |
| `GET` | `/api/sessions/:transactionId/invoice` | Read a generated invoice |
| `WS` | `/ocpp/:chargerId` | Charger/simulator traffic |

The browser simulator sends charger messages over the WebSocket. Dashboard
HTTP reads are used for durable summaries and invoices. A future production
dashboard can add a dedicated CSMS-to-dashboard event stream; the current
single-browser demo derives live card state from its own simulator messages and
CSMS reads.

### 6.3 CSMS-to-allocator contract

The CSMS calls:

```text
POST http://<allocator-host>:8787/v1/allocate
Content-Type: application/json
```

Request:

```json
{
    "sitePowerLimitKw": 100,
    "activeChargers": [
        {
            "chargerId": "sim-car-001",
            "requestedPowerKw": 80,
            "maxPowerKw": 80
        },
        {
            "chargerId": "sim-car-002",
            "requestedPowerKw": 80,
            "maxPowerKw": 80
        }
    ]
}
```

Response:

```json
{
    "sitePowerLimitKw": 100,
    "totalAllocatedPowerKw": 100,
    "allocations": [
        { "chargerId": "sim-car-001", "allocatedPowerKw": 50 },
        { "chargerId": "sim-car-002", "allocatedPowerKw": 50 }
    ]
}
```

The request is a decision input, not a command to hardware. Hono owns the
subsequent outbound charger message in the Phase 2 design.

## 7. Smart load-balancing design

### 7.1 Inputs

For each rebalance, Hono supplies:

- The configured site power limit in kW.
- The active charger set for that site.
- Each charger’s current requested power.
- Each charger’s maximum permitted power.

The current demo uses the configured maximum charger power as the simulator’s
request and maximum. Per-charger limits can be made configurable later.

### 7.2 Algorithm

Version 1 uses fair water-filling:

1. Reject negative, non-finite, duplicate, or invalid charger inputs.
2. Clamp each charger’s demand to `min(requestedPowerKw, maxPowerKw)`.
3. Divide remaining site capacity evenly among chargers still below their
   demand.
4. Fix any charger whose demand is below its share.
5. Repeat until all demand is satisfied or the site capacity is exhausted.
6. Apply a final safety cap so the returned total cannot exceed the site
   limit.

### 7.3 Hypothetical capacity example

This is an illustrative calculation, not a measured electrical result:

| Site limit | Active chargers | Demand per charger | Allocation per charger | Total |
| ---: | ---: | ---: | ---: | ---: |
| 100 kW | 2 | 80 kW | 50 kW | 100 kW |
| 100 kW | 3 | 80 kW | 33.3 kW | about 100 kW |
| 100 kW | 1 | 80 kW | 80 kW | 80 kW |

The core invariant is:

```text
0 <= totalAllocatedPowerKw <= sitePowerLimitKw
```

Hono triggers a new calculation when an active session starts or stops, a
charger disconnects, or the site power limit changes. In the Phase 2 simulator
demo, Hono sends each successful allocation back as an outbound charging
profile call and the simulator acknowledges/displays the applied value.

## 8. State and data ownership

```text
Event or command
       │
       ▼
CSMS validates message and transition
       │
       ├── durable record ───────► PostgreSQL
       │                           source of truth
       └── live connection state ─► process memory
                                   current demo optimization
```

### Durable state rules

- A charger is identified by its unique `chargePointId`.
- A connector is unique within a charger.
- An OCPP message is deduplicated by charger and message ID.
- A session owns its meter readings and at most one invoice.
- The invoice stores the tariff used at stop time so later tariff changes do
  not rewrite historical billing.

### Transient state rules

- The live WebSocket registry maps a charger ID to its current socket.
- The process tracks the latest state needed for the running dashboard.
- A process restart can lose live sockets, but durable records remain.
- Redis is the future replacement when shared state is required across CSMS
  instances.

## 9. Reliability and failure handling

### Charger and network failures

- A disconnected socket is removed from the live registry.
- Persisted charger connectivity is marked offline when possible.
- Reconnection uses the same charger identity and can send a new boot flow.
- Outbound profile calls use a bounded acknowledgement timeout.
- An allocator or profile failure is logged and does not erase the durable
  session record.

### Duplicate and invalid messages

- Envelope shape and action payloads are validated at the WebSocket boundary.
- Duplicate message IDs are protected by the database uniqueness constraint.
- Transaction messages are checked against the charger and connector context.
- Meter values must contain a valid cumulative Wh reading.
- Invoice creation is tied to the accepted stop transition.

### Database and service failures

- PostgreSQL is required for the CSMS startup path.
- The Go service is stateless and can be restarted without losing history.
- Health endpoints make service availability visible during demos.
- Docker Compose gives every service a predictable local network name.

The current design is not a high-availability deployment. Adding retries,
dead-letter handling, distributed locks, and multiple CSMS replicas should be
treated as a separate production-hardening effort.

## 10. Security boundary

Current demo protections:

- Environment variables hold database and service URLs.
- CORS is restricted to the configured dashboard origin.
- Request payloads are validated before persistence or allocation.
- Unknown fields in allocator requests and malformed allocator requests are
  rejected.
- Database constraints protect identity and relationship integrity.

Required before production use:

- Charger authentication and authorization.
- Operator login and role-based permissions.
- TLS for browser and charger connections.
- Secret management outside checked-in environment examples.
- Rate limiting and audit logging for administrative operations.

These production controls are intentionally documented as future work rather
than falsely implied by the local capstone demo.

## 11. Deployment design

The target local deployment is a single Docker Compose stack:

```text
┌───────────────┐     ┌─────────────┐     ┌────────────────┐
│ postgres      │     │ load-balancer│     │ csms           │
│ :5433 host    │◄────│ :8787       │◄────│ :6773          │
└───────────────┘     └─────────────┘     └───────┬────────┘
                                                  │
                                           ┌──────▼───────┐
                                           │ dashboard    │
                                           │ :9000        │
                                           └──────────────┘
```

From the repository root, the intended team setup is:

```sh
docker compose up --build -d
```

The Compose deployment is a local demonstration environment. It is not a
claim that the services are ready for an internet-facing production cluster.

## 12. Project phases and acceptance criteria

### Phase 1: CSMS foundation

Demonstrate:

- Multiple simulated chargers connecting to the CSMS.
- Boot and status lifecycle handling.
- Start, meter, and stop transaction flow.
- Durable sessions, meter readings, messages, and invoices.
- Dashboard cards and editable station tariff/capacity settings.

Phase 1 acceptance statement:

> VoltGrid can manage multiple simulated chargers, charging sessions, meter
> readings, and billing through a central CSMS.

### Phase 2: smart charging and packaged deployment

Demonstrate:

- Multiple active sessions in one site.
- Hono-to-Go allocation over the JSON contract.
- Fair allocation with total power at or below site capacity.
- Rebalancing after session, disconnect, or capacity changes.
- Simulator acknowledgement and display of the applied limit.
- Full local startup through Docker Compose.

Phase 2 acceptance statement:

> VoltGrid can coordinate multiple active simulated chargers and apply a
> calculated per-charger limit without exceeding the configured site capacity.

### Success criteria

The project is successful when a supervisor can run the stack, connect several
simulated chargers, observe the complete session and billing lifecycle, and
see a repeatable load-balancing scenario whose total allocation never exceeds
the configured site limit.

## 13. Known limitations and next extensions

| Limitation | Safe next extension |
| --- | --- |
| Browser cards disappear on refresh | Persist simulator presets or load charger summaries from the CSMS |
| Live state is process-local | Add Redis and a shared event channel for multiple CSMS instances |
| Charger power is simulated | Validate against a charger simulator that implements the selected OCPP version, then test hardware |
| Per-charger power is configured globally | Add charger-level electrical limits to the data model and UI |
| Tariff is a simple energy rate | Add tariff schedules only after the base billing flow is stable |
| No operator authentication | Add identity, roles, and audit logging before deployment outside the demo |

The design stops at the smallest architecture that proves the capstone’s main
idea: a central CSMS can coordinate durable charging operations and a bounded,
fair site-power allocation across multiple active chargers.
