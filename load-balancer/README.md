# VoltGrid load balancer

This service calculates fair site-power allocations for active EV chargers.
It is a decision service called by the Hono CSMS; it does not connect to
PostgreSQL or speak OCPP directly.

## Run

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

The response contains one allocation per charger and the total allocation. In
the example, both chargers receive `50 kW`, and the total is `100 kW`.

The allocator uses a fair water-filling strategy: low-demand chargers receive
their full demand first, and the remaining capacity is shared equally among
the rest. Input validation rejects negative, non-finite, duplicate, or empty
charger data.

The Hono CSMS calls this endpoint when active sessions change, then sends each
returned limit to a connected browser simulator over its WebSocket. The Go
service itself remains stateless and does not control physical hardware.

## Checks

```sh
go test ./...
go build .
```
