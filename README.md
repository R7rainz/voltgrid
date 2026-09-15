# VoltGrid

VoltGrid is a proposed EV charging-station management system (CSMS). It
connects simulated chargers over OCPP-style WebSockets, persists sessions and
meter readings in PostgreSQL, generates invoices, and delegates site-power
allocation to a small Go service.

## Current stack

- Hono + Bun: CSMS HTTP and WebSocket backend
- Next.js: operator dashboard and browser charger simulator
- Prisma ORM Next + PostgreSQL/Neon: durable data
- Go standard library: smart load-balancer decision service
- Redis: planned for transient live state and pub/sub; not integrated yet

## Repository layout

```text
csms/             Hono CSMS, OCPP handling, Prisma contract, CLI simulator
dashboard/        Next.js operator dashboard and browser simulator
load-balancer/    Go site-power allocation service
docs/             Architecture and supervisor demo plan
```

## Run locally

Use three terminals:

```sh
# Terminal 1: CSMS
cd csms
bun install
bun run dev

# Terminal 2: Go load balancer
cd load-balancer
go run .

# Terminal 3: dashboard
cd dashboard
bun install
bun run dev
```

Open http://localhost:9000. The CSMS runs on port `6773`; the load balancer
runs on port `8787`.

The CSMS reads `DATABASE_URL` from `csms/.env`. Copy `csms/.env.example` and
use the current Neon connection string. The optional integration settings are:

```env
LOAD_BALANCER_URL=http://localhost:8787
CHARGER_MAX_POWER_KW=50
```

## Quick checks

```sh
curl http://localhost:6773/health
curl http://localhost:8787/health
```

Then add a unique simulated charger in the dashboard and choose **Run full
demo**. The browser sends BootNotification, status changes, StartTransaction,
MeterValues, and StopTransaction. The CSMS persists the flow and returns an
invoice.

## Documentation

- [High-level design](docs/high-level-design.md)
- [Architecture](docs/architecture.md)
- [Phase demo plan](docs/demo-phases.md)
- [CSMS guide](csms/README.md)
- [Load-balancer contract](load-balancer/README.md)
