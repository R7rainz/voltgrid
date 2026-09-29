# VoltGrid

VoltGrid is an EV charging-station management system (CSMS) demonstrated with
simulated chargers. It connects chargers over OCPP-style WebSockets, persists
sessions and meter readings in PostgreSQL, generates invoices, and uses a Go
service to share a site's power budget across active vehicles. This is the
Phase 2 branch; hardware control and payment remain simulations.

## Current stack

- Hono + Bun: CSMS HTTP and WebSocket backend
- Next.js: operator dashboard and browser charger simulator
- Prisma ORM Next + PostgreSQL/Neon: durable data
- Go standard library: fair water-filling load-balancer decision service
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

No local Bun, Node.js, Go, or PostgreSQL installation is required.

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

Docker Compose builds the dashboard, CSMS, and Go allocator, starts PostgreSQL,
waits for the services to become healthy, and keeps them running in the
background. The first build can take a few minutes.

Check the service status and print the startup links:

```sh
docker compose ps
docker compose logs info
```

Every service should show `healthy`. Open:

- Dashboard and charger simulator: `http://localhost:9000`
- CSMS health endpoint: `http://localhost:6773/healthz`
- Go allocator health endpoint: `http://localhost:8787/health`
- OCPP WebSocket endpoint: `ws://localhost:6773/ocpp/{chargerId}`
- PostgreSQL: `localhost:5433`

The default local database is created automatically and persists in the
`voltgrid_postgres_data` Docker volume.

### 3. View logs

```sh
docker compose logs -f csms dashboard load-balancer
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
the error. Ensure ports `9000`, `6773`, `8787`, and `5433` are not already in use.

## Quick checks

```sh
curl http://localhost:6773/healthz
```

Run the isolated backend/database verification gate from the repository root:

```sh
./scripts/check-phase1.sh
```

The script starts an isolated PostgreSQL container, applies the Prisma
contract, runs the CSMS unit and end-to-end tests, launches four CLI charger
simulators through the real WebSocket route, builds the CSMS and dashboard,
and removes the test database afterward.

With the Compose stack running, repeat the same test against the **real** Go
service rather than the test allocator:

```sh
PHASE2_REAL_ALLOCATOR=1 LOAD_BALANCER_URL=http://localhost:8787 ./scripts/check-phase1.sh
```

For the Phase 2 demonstration, add three vehicles in the dashboard, each
requesting `40 kW`, then select **Connect** and **Start** for each. With the
default `100 kW` site limit, the live profiles settle at roughly `33.33 kW`
per car; the total stays at or below `100 kW`. Stop one car and the other two
rise to `40 kW` each. The Go service calculates the allocation, the CSMS sends
it using `SetChargingProfile`, and each simulated charger acknowledges it.
Changing a car's demand or the site capacity triggers another recalculation.

For the Phase 2 fault demo, keep three `40 kW` sessions active and select
**Inject fault** on one card. VoltGrid pauses its billable meter readings,
applies a `0 kW` simulator profile, and gives the freed capacity to healthy
cars. Select **Recover charger** to restore its share. The focused car's
**VoltGrid Black Box** panel replays the persisted status and acknowledged
profile sequence. This is simulated fault handling, not physical charger
diagnosis, hardware enforcement, or automatic repair. See the
[Phase demo plan](docs/demo-phases.md) for the exact walkthrough.

**Run full demo** performs a short accelerated session with meter readings,
an invoice, and a frontend-only mock payment. No physical charger, actual
energy transfer, or payment settlement is involved. Use manual **Start** to
keep multiple sessions open while explaining live balancing.

## Documentation

- [High-level design](docs/high-level-design.md)
- [Architecture](docs/architecture.md)
- [Phase demo plan](docs/demo-phases.md)
- [CSMS guide](csms/README.md)
- [Load-balancer contract](load-balancer/README.md)
