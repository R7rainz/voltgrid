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

## Run locally with Docker

### Prerequisites

- Git
- Docker Desktop, or Docker Engine with Docker Compose v2

No local Bun, Node.js, Go, or PostgreSQL installation is required for the
Phase 1 demo.

### 1. Get the project

```sh
git clone https://github.com/R7rainz/voltgrid.git
cd voltgrid
```

If the repository is already cloned, open a terminal in its root directory.

### 2. Build and start the application

```sh
docker compose up --build -d
```

Docker Compose builds the dashboard and CSMS, starts PostgreSQL, waits for the
services to become healthy, and keeps them running in the background. The
first build can take a few minutes.

Check the service status and print the startup links:

```sh
docker compose ps
docker compose logs info
```

Every service should show `healthy`. Open:

- Dashboard and charger simulator: `http://localhost:9000`
- CSMS health endpoint: `http://localhost:6773/healthz`
- OCPP WebSocket endpoint: `ws://localhost:6773/ocpp/{chargerId}`
- PostgreSQL: `localhost:5433`

The default local database is created automatically and persists in the
`voltgrid_postgres_data` Docker volume.

### 3. View logs

```sh
docker compose logs -f csms dashboard
```

Press `Ctrl+C` to stop following the logs; the containers continue running.

### 4. Stop or reset VoltGrid

Stop the application without deleting database data:

```sh
docker compose down
```

Delete the local database and start again from a clean state:

```sh
docker compose down --volumes
docker compose up --build -d
```

After pulling code changes, run `docker compose up --build -d` again to rebuild
and replace the affected containers.

If startup fails, use `docker compose ps` and `docker compose logs` to inspect
the error. Ensure ports `9000`, `6773`, and `5433` are not already in use.

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
