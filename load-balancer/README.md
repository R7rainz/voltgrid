# VoltGrid load balancer

This service calculates policy-based site-power allocations for active EV chargers.
It is a decision service called by the Hono CSMS; it does not connect to
PostgreSQL or speak OCPP directly.

## Run with Docker Compose

From the repository root, start the complete VoltGrid stack with one command:

```sh
docker compose up --build -d
```

The load balancer is then available at `http://localhost:8787`.

## Optional local development

```sh
go run .
```

Default address: `http://localhost:8787`. Override it with
`LOAD_BALANCER_ADDR`, for example `LOAD_BALANCER_ADDR=:8790 go run .`.

## Contract

`POST /v1/allocate`

```json
{
    "sitePowerLimitKw": 100,
    "policy": "demand-weighted",
    "feederLimits": [
        { "feederId": "main-feeder", "powerLimitKw": 100 }
    ],
    "activeChargers": [
        {
            "chargerId": "sim-car-001",
            "requestedPowerKw": 80,
            "maxPowerKw": 80,
            "feederId": "main-feeder",
            "energyRequiredKwh": 20,
            "energyDeliveredKwh": 0,
            "departureAt": "2026-10-07T18:00:00Z",
            "priority": 0
        },
        {
            "chargerId": "sim-car-002",
            "requestedPowerKw": 80,
            "maxPowerKw": 80
        }
    ]
}
```

The response contains one allocation per charger and the total allocation. In
the example, both chargers receive `50 kW`, and the total is `100 kW`.

The optional `policy` field selects the live algorithm:

- `demand-weighted` (default): if overloaded, each charger receives a
  proportion of the site limit based on its effective demand.
- `equal-share`: water-filling baseline; available power is shared evenly
  and low-demand chargers release unused capacity.
- `fcfs`: first-come, first-served; input order receives capacity first.
- `deadline-aware`: weights remaining energy, departure time, and vehicle
  priority before applying capped weighted sharing.

The response exposes `requestedPowerKw`, `allocatedPowerKw`,
`demandSharePct`, `unmetPowerKw`, and a human-readable `reason` for every
charger. It also exposes the effective limit, the `site → feeder → charger`
constraint path, and per-feeder requested/allocated power. Input validation
rejects negative, non-finite, duplicate, or empty charger/feeder data. If
total demand is below the applicable tree limits, every policy gives each
charger its full effective demand.

The tree is intentionally small for VoltGrid: the site is the root, each
configured feeder is a child, and chargers are leaves. Feeder limits are
enforced before a leaf policy is applied. With no explicit feeder limit, a
charger uses the site's limit as its feeder limit.

The Hono CSMS calls this endpoint when active sessions change, then sends each
returned limit to a connected browser simulator over its WebSocket. The Go
service itself remains stateless and does not control physical hardware.

## Policy comparison lab

The supervisor-facing Grid Operations Lab uses POST /v1/compare to replay
the same site conditions against four policies:

- fcfs: first-come, first-served baseline; early vehicles can consume the
  available site power.
- equal-share: fair water-filling; active vehicles share the available power
  without exceeding the site limit.
- demand-weighted: vehicles receive power proportional to their active demand.
- deadline-aware: gives more weight to vehicles with less time remaining,
  higher priority, and a larger unmet energy requirement.

The request includes the site limit, building load, solar contribution, tariff,
vehicle arrival/departure windows, required energy, maximum power, and
priority. The response includes a time-step trace, per-vehicle delivery and
deadline status, peak grid import, fairness, and modeled energy plus demand
cost. These costs are a simulation tool for comparing policies, not billing
or a claim about a utility tariff.

The Hono proxy exposes the same comparison at
POST /api/simulation/compare, so the dashboard can run the lab without
connecting the browser directly to the Go service.

## Checks

```sh
go test ./...
go build .
```
