# VoltGrid

VoltGrid is a proposed EV charging-station management system (CSMS). It
connects simulated chargers over OCPP-style WebSockets, persists sessions and
meter readings in PostgreSQL, and generates invoices. This branch represents
the Phase 1 CSMS foundation and deliberately leaves smart load balancing for
Phase 2.

## Current stack

- Hono + Bun: CSMS HTTP and WebSocket backend
- Next.js: operator dashboard and browser charger simulator
- Prisma ORM Next + PostgreSQL/Neon: durable data
- Go standard library: staged Phase 2 load-balancer decision service
- Redis: planned for transient live state and pub/sub; not integrated yet

## Repository layout

```text
csms/             Hono CSMS, OCPP handling, Prisma contract, CLI simulator
dashboard/        Next.js operator dashboard and browser simulator
load-balancer/    Go site-power allocation service
docs/             Architecture and supervisor demo plan
```

## Run everything with Docker

Install Docker Engine with Docker Compose, then run this once from the
repository root:

```sh
docker compose up --build
```

Compose builds and starts PostgreSQL, the Bun/Hono CSMS, and the Next.js
dashboard. When every service is healthy, the terminal prints
a `VOLTGRID IS READY` banner containing these links:

- Dashboard: `http://localhost:9000`
- CSMS health: `http://localhost:6773/healthz`
- OCPP WebSocket: `ws://localhost:6773/ocpp/{chargerId}`
- PostgreSQL: `localhost:5433`

Press `Ctrl+C` to stop the foreground logs. Remove the containers afterward
with:

```sh
docker compose down
```

To run in the background instead, use `docker compose up --build -d`, followed
by `docker compose logs info` to print the same link banner.

## Quick checks

```sh
curl http://localhost:6773/healthz
```

Run the complete Phase 1 verification gate from the repository root:

```sh
./scripts/check-phase1.sh
```

The script starts an isolated PostgreSQL container, applies the Prisma
contract, runs the CSMS unit and end-to-end tests, launches four CLI charger
simulators through the real WebSocket route, builds the CSMS and dashboard,
and removes the test database afterward.

Then add a unique simulated charger in the dashboard and choose **Run full
demo**. The browser sends BootNotification, status changes, StartTransaction,
MeterValues, and StopTransaction. The CSMS persists the flow and returns an
invoice.

For the capacity demonstration, add four cars and start their demos together.
At the default `100 kW` site limit, each car requests `50 kW`. The unmanaged
Phase 1 baseline gives the first two cars `50 kW` each and leaves the later two
at `0 kW`, making the need for Phase 2 smart allocation visible.
Requests are all-or-nothing: at a `100 kW` site, three `40 kW` requests receive
`40`, `40`, and `0 kW`; the remaining `20 kW` is unused because it cannot meet
the third car's full request. The Go allocator is not called in Phase 1.

## Documentation

- [High-level design](docs/high-level-design.md)
- [Architecture](docs/architecture.md)
- [Phase demo plan](docs/demo-phases.md)
- [CSMS guide](csms/README.md)
- [Load-balancer contract](load-balancer/README.md)
