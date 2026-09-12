# VoltGrid

VoltGrid is a proposed EV Charging Station Management System (CSMS). It
connects chargers to a central backend, manages charging sessions, records
energy readings, generates invoices, monitors charger state, and distributes
limited site power across active chargers.

The project is hardware-free for development and demonstration: the dashboard
creates browser-based charger simulators that use the same WebSocket path as a
physical charger would use.

## Project status

The repository is developed continuously, but the capstone can be presented in
two milestones.

### Phase 1 — CSMS foundation

This is the half-project milestone to show the supervisor. It proves that the
core charging-management workflow exists end to end:

- Hono + Bun accepts OCPP-style charger WebSocket connections.
- A charger sends `BootNotification` and receives an acceptance response.
- `StatusNotification` updates connector availability and fault information.
- `StartTransaction` creates an active charging session and transaction ID.
- `MeterValues` records cumulative energy readings in Wh.
- `StopTransaction` closes the session and creates an INR invoice from the
  configured tariff.
- PostgreSQL stores chargers, connectors, OCPP messages, sessions, meter
  readings, and invoices.
- The Next.js dashboard can add multiple simulated vehicles and run each
  charger independently.
- Station capacity and tariff are editable through the dashboard.
- The CLI simulator can repeat the same charger lifecycle without a physical
  car.

Phase 1 demo claim:

> VoltGrid can manage multiple simulated chargers, charging sessions, meter
> readings, and billing through a central CSMS.

### Phase 2 — smart charging and final demo

The final project adds the power-management loop on top of Phase 1:

- The CSMS reads the configured site power limit and active sessions.
- Hono sends active charger demand to the Go allocation service over JSON HTTP.
- The Go service uses fair water-filling allocation and never returns a total
  above the site limit.
- Hono sends the returned per-charger limit back over the charger WebSocket as
  a charging-profile command.
- The browser simulator acknowledges that command and displays the applied
  allocation on the vehicle card.
- Rebalancing runs when a session starts or stops, so the active set is
  recalculated.
- A `100 kW` site with two `50 kW` active chargers demonstrates `50 kW` each;
  adding a third charger demonstrates the limit being shared again.

Phase 2 demo claim:

> VoltGrid can coordinate multiple active simulated chargers and apply a
> calculated per-charger power limit without exceeding the configured site
> capacity.

The Phase 2 power command is demonstrated through the simulator. It does not
control physical electrical hardware, and it must not be presented as a field
deployment or a measured performance result.

## Current architecture

```text
                         browser
        +----------------------------------------+
        | Next.js operator dashboard :9000        |
        | - operator controls                     |
        | - multiple browser charger simulators   |
        +------------------+---------------------+
                           |
              HTTP API     |     WebSocket OCPP-style traffic
                           v
        +----------------------------------------+
        | Hono + Bun CSMS :6773                  |
        | - validation and charger connections   |
        | - session and billing workflows        |
        | - transient charger state              |
        +----------+------------------+----------+
                   |                  |
          Prisma contract             | JSON HTTP /v1/allocate
                   v                  v
        +-------------------+   +----------------------+
        | PostgreSQL         |   | Go load balancer :8787|
        | durable history    |   | fair allocation       |
        +-------------------+   +----------------------+

        Redis: planned for transient state/pub-sub; not required by the
        current local demo path.
```

### Component responsibilities

| Component | Responsibility |
| --- | --- |
| Next.js dashboard | Operator controls, vehicle cards, site settings, invoices, and browser charger simulation. |
| Hono + Bun | HTTP API, WebSocket endpoint, input validation, OCPP-style message handling, session lifecycle, and billing. |
| PostgreSQL + Prisma ORM Next | Durable source of truth for operational and billing records. |
| Go load balancer | Stateless site-power allocation calculation. It does not access PostgreSQL or speak to chargers directly. |
| In-process charger state | Connected status, connector status, last-seen time, and the latest applied allocation for the running demo. |
| Docker Compose | Reproducible local runtime for PostgreSQL, CSMS, dashboard, and load balancer. |
| Redis | Future transient state and pub/sub option; it is not currently on the critical path. |

## Technical flow

### Charger/session flow

```text
Simulator -> WebSocket -> BootNotification -> CSMS -> Accepted
Simulator -> StatusNotification ----------------> CSMS -> response
Simulator -> StartTransaction ------------------> CSMS -> transaction ID
Simulator -> MeterValues -----------------------> CSMS -> persisted reading
Simulator -> StopTransaction -------------------> CSMS -> invoice record
```

### Smart-charging flow

```text
Session starts/stops
        |
        v
CSMS reads site limit + active sessions from PostgreSQL
        |
        v
POST /v1/allocate to Go service
        |
        v
Fair per-charger allocation, total <= site limit
        |
        v
CSMS sends charging-profile command over the charger's WebSocket
        |
        v
Simulator acknowledges and shows applied kW on its card
```

PostgreSQL remains the durable source of truth. The live socket registry and
latest allocation are process memory for the zero-cost demo. Redis can replace
that transient layer later if multiple CSMS instances are deployed.

## Data model

- `Site` stores the station name, site power limit, and tariff.
- `Charger` stores the charge-point identity, vendor/model, site relation, and
  connection timestamps.
- `Connector` stores connector number, status, and error code.
- `OcppMessage` stores received charger messages for traceability.
- `ChargingSession` stores transaction state and start/stop meter values.
- `MeterReading` stores cumulative energy readings for a session.
- `Invoice` stores energy, tariff, amount, currency, and invoice status.

## Run everything with Docker

Requirements: Docker Engine and Docker Compose. No Bun, Go, or local
PostgreSQL installation is needed.

From the repository root:

```sh
docker compose up --build -d
```

Open the dashboard at [http://localhost:9000](http://localhost:9000).

The services are available at:

- Dashboard: `http://localhost:9000`
- CSMS health: `http://localhost:6773/health`
- Go allocator health: `http://localhost:8787/health`
- PostgreSQL from the host: port `5433`

The compose file creates a local PostgreSQL volume and applies the checked-in
Prisma contract when the CSMS starts. To stop the services while keeping the
database volume:

```sh
docker compose down
```

To remove the local database volume as well, use `docker compose down -v`.
That removes demo data and is not recoverable from the local volume.

## Optional: run individual services without Docker

Use this only when developing one service in isolation. It requires separate
terminals and a separately available PostgreSQL database; Docker Compose is the
recommended path for the complete demo.

The CSMS reads `DATABASE_URL` from `csms/.env`. Copy `csms/.env.example` and
set it to Neon or another PostgreSQL database. The Go integration settings are:

```env
LOAD_BALANCER_URL="http://localhost:8787"
CHARGER_MAX_POWER_KW="50"
```

## Demo procedure

1. From the repository root, run `docker compose up --build -d`.
2. Add two or three simulated vehicles with unique charger IDs.
3. Use **Connect** to show boot and availability.
4. Use **Start** or **Run full demo** to create sessions.
5. Use **+1 kWh** to send more meter readings.
6. Change the station capacity to make allocation visible, for example `100`.
7. Start multiple vehicles and show each card’s applied power allocation.
8. Stop one vehicle and show the remaining active set being recalculated.
9. Stop the remaining sessions and show the generated invoices.

For the supervisor, explain that browser cards are repeatable charger clients;
they are not fake database rows or a replacement for validating a physical
charger in a later deployment.

## Scope boundaries

Currently in scope:

- OCPP-style WebSocket connectivity and validated messages
- Charger registration and health/status tracking
- Charging sessions and cumulative meter readings
- Configurable energy tariff and invoice generation
- Operator dashboard and browser charger simulation
- Go-based site-power allocation
- Simulated application of returned charging limits

Not in the current v1 scope:

- Physical charger or vehicle integration
- Payment gateway settlement
- Mobile applications
- Roaming between charging networks
- Dynamic market pricing
- Machine-learning optimization
- Production-grade multi-region deployment

## Verification commands

```sh
cd csms && bun run build
cd ../dashboard && bun run build
cd ../load-balancer && go test ./... && go build .
```

The most important Phase 2 invariant is:

```text
sum(all charger allocations) <= configured site power limit
```

The Go allocator has a unit test for the two-charger `100 kW` scenario and
input validation for invalid or duplicate charger requests.

## Repository layout

```text
compose.yml       Complete local stack
csms/             Hono CSMS, Prisma contract, migrations, CLI simulator
dashboard/        Next.js operator dashboard and browser charger simulator
load-balancer/    Go allocation service
docs/             Architecture and supervisor demo notes
```

## Branches

- `codex/phase-1`: frozen supervisor milestone containing the CSMS foundation.
- `codex/phase-2`: active branch for smart charging and the completed demo.

The project is built continuously rather than being developed as two separate
applications; the branches only preserve what should be shown at each review.
