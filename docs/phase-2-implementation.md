# Phase 2 implementation and evidence guide

This is the source-grounded handoff for anyone maintaining VoltGrid or writing its later Phase 2 capstone report. It describes the **implemented software demo**, not a certified charger product. It was checked against the `codex/phase-2` branch and its verification run on 30 September 2026. Read the linked source files before carrying a claim into a report if the branch has changed.

VoltGrid's Phase 2 result is a working software control loop: simulated chargers report their state and power requests to the Hono CSMS; the CSMS asks a Go service to allocate a configured site budget; connected simulators acknowledge outbound charging profiles; and PostgreSQL preserves charging, billing, and selected incident events. No physical EV, metered electrical load, payment settlement, or formal OCPP certification has been demonstrated.

| Status | Phase 2 capability |
| --- | --- |
| Implemented and covered by automated checks | Multi-charger OCPP-style lifecycle, durable sessions/invoices, Go water-filling, CSMS profile orchestration, simulated fault/recovery, and Black Box event API |
| Implemented as demonstration UI | Vehicle arrival/cable scene, synthetic battery and meter progress, receipt presentation, and mock QR/payment confirmation |
| Not implemented | Redis coordination, real authentication/roles, payment gateway, physical charger enforcement, and full OCPP conformance testing |

## What Phase 2 adds to the Phase 1 baseline

Phase 1 already had charger registration, connector status, charging sessions, meter readings, invoices, and an intentionally unmanaged first-come power display. Phase 2 replaces that display with a live allocation path. It adds changing demand and capacity, charger-side profile acknowledgements, a simulated fault and recovery scenario, and the read-only VoltGrid Black Box incident view. The same Compose stack packages the Go service with the CSMS, dashboard, and local PostgreSQL.

For the supervisor, the simplest comparison is three simulated cars each requesting 40 kW at a 100 kW site:

| Situation | Phase 1 unmanaged baseline | Phase 2 applied simulator profiles |
| --- | --- | --- |
| Three active 40 kW requests | 40, 40, 0 kW; 20 kW unused | 33.333, 33.333, 33.333 kW; 99.999 kW total after integer-watt rounding |
| One car reports a fault | No smart redistribution | Faulted car targeted at 0 kW; two healthy cars at 40 kW each, after acknowledgements |
| Faulted car reports recovery | Not applicable | Three cars return to about 33.333 kW each |

These are software allocation/profile values, **not measured electrical power**. The total limit is enforced in the decision and simulated command path; physical site safety would need real charger interoperability, telemetry, and independent electrical protection.

## Runtime components and ownership

```text
Browser: Next.js dashboard + up to four charger simulators (:9000)
    | HTTP reads/settings                 | OCPP-style JSON over WebSocket
    +-------------------------------------+-------------------------------+
                                          v
                              Hono + Bun CSMS (:6773)
                         API, OCPP dispatch, sessions, billing,
                         in-process sockets/state, rebalance orchestration
                              |                         |
                    Prisma ORM Next                JSON HTTP POST
                              v                         v
                     PostgreSQL (:5433)         Go allocator (:8787)
                     durable records              stateless decision
```

The dashboard is both an operator view and a **charger simulator**. A vehicle card is not a driver account or a real EV telemetry source. It opens a WebSocket directly to the CSMS and responds to server-initiated `SetChargingProfile` calls. There is no backend-to-operator WebSocket feed: the dashboard polls charger/site APIs every 2 seconds to infer backend availability, and the focused Black Box every 1.5 seconds. Charger profile updates arrive on the simulator's OCPP-style socket.

The CSMS owns the API, charger sockets, protocol validation, persistence, billing, and orchestration. The Go service receives a complete allocation request and returns a decision; it does not access PostgreSQL or send OCPP messages. PostgreSQL is the durable source of truth. The live socket registry, requested power, and latest acknowledged allocations are in the CSMS process memory. Redis is documented as a future option but **is not deployed or integrated**.

Source entry points: [CSMS app](../csms/src/app.ts), [server adapter](../csms/src/index.ts), [OCPP route](../csms/src/routes/ocpp.routes.ts), [allocator integration](../csms/src/modules/load-balancer/load-balancer-client.ts), [Go service](../load-balancer/main.go), [dashboard](../dashboard/app/page.tsx), [database contract](../csms/prisma/contract.prisma), and [Compose](../compose.yml).

## Startup and configuration

From the repository root, `docker compose up --build -d` builds the three application images and starts PostgreSQL 18, Go, CSMS, and Next.js. Compose waits for PostgreSQL and Go health before starting CSMS, then waits for CSMS before dashboard. The CSMS container runs the Prisma contract update, seeds a site if none exists, and starts on port 6773. The seed is `VoltGrid Demo Site`, 100 kW, and 800 paise/kWh (₹8/kWh); it does not overwrite an existing site. The local PostgreSQL volume persists across `docker compose down`. `docker compose down --volumes` deletes that local data and must not be used casually.

| Service | Local endpoint | Important configuration |
| --- | --- | --- |
| Dashboard | `http://localhost:9000` | `NEXT_PUBLIC_CSMS_HTTP_URL`, `NEXT_PUBLIC_CSMS_WS_URL`; these are built into the browser bundle |
| CSMS | `http://localhost:6773/healthz`, `ws://localhost:6773/ocpp/{chargerId}` | `DATABASE_URL`, `LOAD_BALANCER_URL`, `DASHBOARD_ORIGIN`, `PORT`, optional `CHARGER_MAX_POWER_KW` fallback |
| Go allocator | `http://localhost:8787/health` | `LOAD_BALANCER_ADDR`; defaults to `:8787` |
| PostgreSQL | host port `5433` | Compose's local demo credentials and named volume |

The fallback charger request is 50 kW when a connected active charger has not sent a VoltGrid power request. It is not an independently measured EV or charger hardware limit. The CSMS `.env.example` is for running outside the root Compose stack. See the [root setup guide](../README.md) for commands and the [Compose file](../compose.yml) for exact dependency and health settings.

## Durable model and transient state

The Prisma contract defines seven entities:

| Entity | Purpose and relevant constraints |
| --- | --- |
| `Site` | Name, configured `powerLimitKw`, current `tariffPaisePerKwh`; one seeded site is used by the demo |
| `Charger` | Unique `chargePointId`, vendor/model, site relation, connected flag, last-seen timestamp |
| `Connector` | Charger-local number, status/error code; unique `(chargerId, connectorNumber)` |
| `OcppMessage` | Inbound action/payload and accepted outbound profile/payload; unique `(chargerId, messageId)` |
| `ChargingSession` | Transaction ID, `idTag`, active/completed status, start/last/stop meter in Wh, timestamps, charger and connector |
| `MeterReading` | Cumulative Wh reading and timestamp linked to a session |
| `Invoice` | One per session, with energy Wh, tariff snapshot, amount in paise, INR, issue status/time |

The important write sequence is: Boot writes `Charger` and an inbound `OcppMessage`; status writes `Connector` and an inbound message; start writes `ChargingSession` and a message; each accepted meter call writes `MeterReading` and updates `lastMeterWh`; an accepted outbound profile writes an outbound `OcppMessage`; stop writes the final reading, completes the session, and upserts `Invoice`. `Site` settings changes are separate HTTP writes. The exact schema and constraints are in [the contract](../csms/prisma/contract.prisma).

Boot and status changes, session changes, meter writes, and invoice creation use database transactions where a related set of records must move together. The in-memory [charger state](../csms/src/modules/chargers/charger-state.ts) supplies `GET /api/chargers`, including requested and allocated kW. The [socket registry](../csms/src/modules/chargers/charger-connections.ts) correlates outbound calls with the correct charger response, has a 5-second response timeout, and rejects pending calls on disconnect. Both maps are process-local and disappear on restart. Stored session/message/invoice history does not.

## Charger connection and message lifecycle

This is an **OCPP 1.6-style subset**, not a claim of full OCPP 1.6 or 2.0.1 compliance. The WebSocket endpoint accepts JSON arrays in the forms `CALL [2, uniqueId, action, payload]`, `CALLRESULT [3, uniqueId, payload]`, and `CALLERROR [4, uniqueId, code, description, details]`. The browser simulates the following path:

1. Add a vehicle card and choose requested power and an energy-plan display value. The card starts as browser-only state; no charger has connected yet.
2. Connect: the browser animates a cable, opens `/ocpp/{chargerId}`, sends `BootNotification` with simulated vendor/model, then `StatusNotification(Available, NoError)`. Boot requires a configured site and upserts the charger record.
3. Start: the browser sends VoltGrid-specific `DataTransfer` (`vendorId: "VoltGrid"`, `messageId: "PowerRequest"`, JSON `data` containing `requestedPowerKw`), reports `Preparing`, sends `StartTransaction`, then reports `Charging`.
4. The CSMS creates or resumes the session, triggers a rebalance, calls Go, sends `SetChargingProfile` to affected sockets, and waits for each `Accepted` result. The simulator updates its displayed allocation and acknowledges the call.
5. `MeterValues` sends cumulative Wh readings for an active transaction. The CSMS stores accepted readings and updates the session's last meter. `StopTransaction` supplies the final meter, completes the session, writes the invoice, and triggers a new rebalance. The dashboard then fetches the invoice over HTTP.

`Heartbeat` is also supported and returns server time. Unknown actions return `NotSupported`. Malformed envelopes and invalid payloads produce OCPP-style errors when a usable call ID is available. The route checks connector/status/error codes, timestamps, positive IDs, and non-decreasing cumulative meters. For a single WebSocket connection, inbound IDs are stored as `<connection UUID>:<call ID>`, allowing a charger to reuse call IDs after reconnecting. Repeated start calls can return the existing transaction; repeated meter calls do not add a second reading; a repeated stop of a completed transaction returns accepted. These are implemented duplicate-handling cases, not an exactly-once guarantee across every possible failure.

There is no separate OCPP `Authorize` call in the current flow. `idTag` is recorded in `StartTransaction`; authentication/role-based access and real driver identity are not implemented. The VoltGrid `DataTransfer` power request is a demo extension and is kept in memory, not in a persistent demand table.

## HTTP and internal service contracts

| CSMS route | Current behavior |
| --- | --- |
| `GET /healthz` and `/health` | Process health JSON; does not prove database or allocator availability |
| `GET /api/chargers` | In-process charger/connector state, demand, and last acknowledged allocation; may be empty after restart until chargers reconnect |
| `GET /api/site` | Reads the first site from PostgreSQL and returns the in-memory live allocation policy |
| `PATCH /api/site/policy` | Pauses active profiles, changes the in-memory policy, and applies new profiles |
| `PATCH /api/site` | Requires finite, non-negative numeric `powerLimitKw` and non-negative integer `tariffPaisePerKwh`; saves and asynchronously requests a rebalance |
| `GET /api/sessions/:transactionId/invoice` | Returns a persisted invoice plus derived kWh and formatted INR amount; 404 until issued |
| `GET /api/chargers/:chargerId/black-box` | Read-only latest-fault timeline, described below |

The CSMS sends `POST /v1/allocate` to the Go service with `{ "sitePowerLimitKw": number, "policy": "fcfs" | "equal-share" | "demand-weighted", "activeChargers": [{ "chargerId": string, "requestedPowerKw": number, "maxPowerKw": number }] }`. Go responds with the selected policy, total requested/allocated power, and per-charger `requestedPowerKw`, `allocatedPowerKw`, `demandSharePct`, `unmetPowerKw`, and `reason`. The CSMS currently sets each `maxPowerKw` equal to the requested power; a separately measured hardware maximum is not supplied. A faulted, unavailable, or non-`NoError` active connector remains in the request with zero demand so it can receive a zero profile.

For example, with a 100 kW site and three 40 kW requests, Go returns about 33.333333 kW per charger. The CSMS floors those values to 33,333 W in its outbound calls. The conceptual command to one simulator is:

```json
[2, "csms-1", "SetChargingProfile", {
  "connectorId": 1,
  "csChargingProfiles": {
    "chargingProfileId": 1,
    "stackLevel": 0,
    "chargingProfilePurpose": "TxProfile",
    "chargingProfileKind": "Absolute",
    "chargingSchedule": {
      "chargingRateUnit": "W",
      "chargingSchedulePeriod": [{ "startPeriod": 0, "limit": 33333 }]
    }
  }
}]
```

The call ID is generated at runtime. The browser simulator responds `[3, "csms-1", {"status":"Accepted"}]` only after parsing a valid non-negative first schedule limit. This sample documents the current simulator contract; it must not be reused as a claim of standards-certified charging-profile interoperability.

Go rejects negative/non-finite capacity or charger values, empty/duplicate charger IDs, more than 1,000 entries, unknown JSON fields, more than 1 MiB of request body, and trailing JSON. The CSMS checks that the response has exactly one known unique allocation per demand, all values are finite and non-negative, no value exceeds its demand, and the computed sum does not exceed the site limit. Go's response is not blindly trusted. The CSMS call has a 5-second HTTP timeout.

## Power allocation and profile application

The live Go allocator supports three policies. For each charger, effective demand is `min(requestedPowerKw, maxPowerKw)`. `fcfs` fills requests in arrival order. `equal-share` is the capped water-filling baseline. `demand-weighted` gives each charger `siteLimit × effectiveDemand / totalEffectiveDemand` when the site is overloaded; when total demand fits, each charger receives its full demand. It calculates no priority tiers, departure deadlines, battery state, dynamic tariff, or non-EV building load in the live path. The service is stateless and returns an allocation rather than issuing a command.

Examples: a 100 kW site with `demand-weighted` demands of 20, 80, and 100 kW receives 10, 40, and 50 kW. Under `fcfs`, two 80 kW requests receive 80 and 20 kW. Three 40 kW demands receive about 33.333333 kW each from the demand-weighted policy. The CSMS rounds **down** to integer watts for the outbound profile, so the displayed/applied simulator value is 33.333 kW each (99.999 kW combined), not exactly 100 kW.

The CSMS queries the site's limit, active sessions, their connectors, and chargers that are both database-marked connected and present in its live in-memory registry. A rebalance is requested after a successful session start/stop, relevant connector status, power-request update, site settings update, or disconnect. Multiple requests for the same site are coalesced/serialized in one process. The orchestrator compares target power to its last acknowledged in-memory value, sends **decreases before increases**, and waits for each `SetChargingProfile` to return `Accepted` before storing that outbound profile in `OcppMessage` and updating the in-memory allocation. The profile payload uses `TxProfile`, `Absolute`, watts (`W`), one schedule period, and the connector number. It is a software command acknowledged by the simulator, not proof of physical power delivery.

If Go is unavailable, returns an invalid allocation, or a charger rejects/times out on a profile, the CSMS logs the error; it does not roll back the already accepted start/stop/site change. It also does not apply later increases after a failed decrease in that run. A later state change can trigger another rebalance, but there is no durable retry queue, multi-process lock, or independent physical cutoff. Therefore, describe the capacity rule as **validated planned allocation and acknowledged simulator profiles**, not an unconditional electrical safety guarantee.

## Fault isolation and VoltGrid Black Box

The new Phase 2 feature is a repeatable simulated fault investigation:

1. On a charging card, **Inject fault** sends `StatusNotification(Faulted, PowerSwitchFailure)` for its connector. The CSMS persists the status/message, returns the notification acknowledgement, then asynchronously requests a rebalance.
2. The faulted active session contributes zero demand. The CSMS attempts a zero-watt profile for that charger and awaits `Accepted` before increasing healthy chargers' profiles. At a 100 kW site with three original 40 kW requests, the settled software result is 40, 40, 0 kW (80 kW total).
3. While the connector is faulted, a new increasing `MeterValues` reading is rejected and does not advance the session meter. `StopTransaction` with an increased final meter is invalid. This prevents that **simulated** fault interval from creating additional billable energy through those messages; it does not detect physical energy use.
4. **Recover charger** sends `StatusNotification(Charging, NoError)`. The next rebalance restores a share; for three 40 kW requests at 100 kW, profiles return to about 33.333 kW each. Recovery is reported by the simulator/operator, not automatically diagnosed or repaired.

The Black Box endpoint loads that charger's stored OCPP messages, sorts by database ID, starts at the most recent `Faulted` status, converts fault/recovery statuses and **acknowledged** outbound profiles into human-readable events, and returns the last 20. The dashboard polls while that charger is selected; **Replay**, **Next**, and **Latest** move only a UI cursor. Replay never resends an OCPP command or modifies the session. The timeline is per charger and latest fault, **not a complete transaction-scoped forensic log**. It omits meter samples, rejected/failed profile attempts, and raw Go decisions. Its current read scans the charger's history in memory and would need database pagination for large deployments.

One implementation edge to disclose: a faulted session can be stopped with an unchanged final meter; the current stop path marks its connector `Available` even if fault status was present. Use explicit **Recover charger** in the supervised fault demonstration before a normal stop. The stored connector error code and in-memory status may need reconciliation for a production fault lifecycle.

## Session energy, tariff, and invoice semantics

The CSMS stores **cumulative watt-hours**, not increments. Accepted meter readings must be at least the prior session reading. On a valid stop it computes `energyWh = meterStopWh - meterStartWh`, then `amountPaise = round(energyWh * tariffPaisePerKwh / 1000)`. For example, 2,500 Wh at 800 paise/kWh produces 2,000 paise or ₹20.00. One invoice is linked to the completed session and includes its tariff and energy snapshot.

The tariff used is the site's tariff **when the session stops**, not a tariff reserved at start. The dashboard's offer and live cost are estimates based on the currently displayed tariff; they are not a contractual price lock. The dashboard receipt combines the persisted invoice with browser-only vehicle details. Its displayed completion time uses `Invoice.issuedAt`, and its duration uses the browser's local session-start time, so neither is a measured charging duration from the database. The CSS QR and **Simulate payment** button only change local UI state; no payment record, gateway charge, or settlement exists.

## Browser simulation and what its visuals mean

The dashboard admits up to four simultaneous vehicle cards in one browser tab. It starts each new card at a simulated 100,000 Wh meter reading, cycles through four invented vehicle profiles (model, battery, range, starting state of charge), and lets the user enter charger ID, `idTag`, connector number, and requested kW. These vehicle specs and state-of-charge estimates are illustrative UI data; they are **not read from OCPP or a real car**. Cards and mock payment status are local browser state and disappear on refresh. Durable CSMS records remain in PostgreSQL.

The top-view arrival/cable animation and the backend route illustration explain the protocol stages; they are not a trace of packet transit time. **Connect** opens the charger socket and performs boot/status. Manual **Start**, **Meter tick**, and **Stop & invoice** are best for holding several active sessions open and demonstrating reallocation. **Run full charging demo** is accelerated: after connection/start it attempts eight meter ticks separated by roughly 1.5 seconds, then stops and fetches an invoice. The selected 10/20/40 kWh plan is a demo target, not a guaranteed delivered amount. Each tick's synthetic Wh increment is scaled by `min(allocated kW, requested kW) / requested kW`; zero allocation prevents a tick. Consequently the delivered energy and final invoice can be below the selected plan under contention. There is no physical `power × elapsed time` integration or real charger power telemetry.

The displayed live power is the last simulator-acknowledged profile; the site demand and unmet-demand figures are computed from browser cards. Changing a card's demand while charging sends a new VoltGrid `DataTransfer` on input blur. Changing site settings uses the HTTP API. Site input has non-negative validation but no practical engineering ceiling; the demo operator must choose credible values.

## Reproducible verification and evidence

On 30 September 2026, the following checks passed for the Phase 2 branch:

| Check | Command or source | What was established |
| --- | --- | --- |
| CSMS unit tests | `cd csms && bun test` | 8 passed: health routes, request validation, live charger state |
| Type check | `cd csms && bunx tsc --noEmit` | No TypeScript errors |
| Go tests | `cd load-balancer && go test ./...` | Site cap, unequal demand water-filling, and zero-demand fault allocation cases |
| Integrated database/WebSocket tests | `PHASE2_REAL_ALLOCATOR=1 LOAD_BALANCER_URL=http://localhost:8787 ./scripts/check-phase1.sh` | 6 end-to-end tests, 62 assertions: station API, protocol errors, reconnect IDs, idempotent sessions and billing, four concurrent CLI simulators, real-Go rebalance/fault/recovery/no-phantom-energy path |
| Production builds | Same verification script | Bun CSMS bundle and Next.js production build completed |

The gate starts an **isolated test PostgreSQL Compose project** on host port 55432 by default, applies the Prisma contract, runs tests/builds, and removes its own test container and volume on exit. The real-Go mode requires a running allocator at the supplied URL. Without `PHASE2_REAL_ALLOCATOR=1`, the end-to-end suite starts a small test allocator; that mode checks CSMS integration but does **not** prove Go's water-filling behavior. The script retains its historical `check-phase1.sh` name even though it now exercises Phase 2. These are automated software results, not a hardware interoperability, load, security, or payment test.

For a live demonstration, start the root Compose stack, confirm all services are healthy, add cars with unequal requests such as 20, 80, and 100 kW, connect and manually start each, then switch between `demand-weighted`, `equal-share`, and `fcfs`. The dashboard pauses charging during a switch and shows the new allocation reason, requested power, allocated power, unmet power, and live station log. Use **Run full charging demo** separately to show billing; its quick automatic completion is less suitable for demonstrating concurrent balancing. The [demo plan](demo-phases.md) has the shorter supervisor script.

## Boundaries and open engineering work

- There is no verified physical charger, grid meter, electrical cutoff, or standards conformance certification. Only browser/CLI simulators have acknowledged profiles.
- OCPP coverage is a validated subset of common message shapes. `DataTransfer` power demand and the animated car data are VoltGrid demo conventions. No separate OCPP `Authorize` workflow is implemented.
- The demo has no login, driver identity verification, role-based access, WebSocket authentication, or TLS configuration. Default Compose credentials are for local use only. Do not expose this stack to an untrusted network as-is.
- There is no real payment integration. The QR is visual and payment status is frontend-only.
- One CSMS process owns sockets and demand/allocation state. There is no Redis integration, durable command queue, restart recovery of applied profiles, cross-process coordination, or production-grade retry after allocator/profile failure.
- Allocations use configured site capacity, not measured remaining grid headroom or other building loads. The CSMS passes request as `maxPowerKw`; actual charger/vehicle limits are not verified.
- The dashboard polls rather than receiving a dedicated server-to-operator live WebSocket stream. It limits the scene to four locally simulated cars.
- Black Box is a latest-fault, per-charger, last-20-event explanation view, not complete diagnostics or immutable audit evidence. Failed profile attempts are not stored as timeline events.
- Invoice uses stop-time tariff and the receipt's vehicle/time fields include browser-only estimates. The fault-stop connector-status edge described above remains unresolved.

## Handoff for a future Phase 2 report

Use this guide and the linked code/tests as **primary implementation evidence**. Separate the report's design goal (safe site allocation) from its observed result (bounded calculated allocations and acknowledged simulator profiles). Use the verified 100 kW examples with units; avoid inventing throughput, latency, savings, uptime, battery telemetry, or hardware safety measurements. If figures are needed, capture the dashboard and test output from a repeatable local run, label them as simulation, and record the date/configuration. Cite external protocol or reliability literature separately from claims about this repository; a literature source does not prove VoltGrid implements a feature. Do not infer individual team-member contributions from Git authorship without team confirmation.

Relevant companion documents are the [high-level design](high-level-design.md), [architecture overview](architecture.md), [demo phases](demo-phases.md), [CSMS run guide](../csms/README.md), and [Go contract](../load-balancer/README.md). This file records **what the Phase 2 branch does now**; those companion files provide shorter design and demo views.

### Source map for the next maintainer or report writer

| Question | Source to inspect |
| --- | --- |
| What are the persisted fields and uniqueness rules? | [Prisma contract](../csms/prisma/contract.prisma) and [database connection](../csms/src/infrastructure/database/db.ts) |
| Where are OCPP validation, transaction, meter, and invoice decisions? | [OCPP route](../csms/src/routes/ocpp.routes.ts) |
| How do live sockets and per-charger state work? | [Socket registry](../csms/src/modules/chargers/charger-connections.ts) and [charger state](../csms/src/modules/chargers/charger-state.ts) |
| How are active demands read, checked, ordered, and applied? | [CSMS allocator client](../csms/src/modules/load-balancer/load-balancer-client.ts) |
| What exactly does fair allocation calculate? | [Go implementation](../load-balancer/main.go) and [Go tests](../load-balancer/main_test.go) |
| Which HTTP routes feed the dashboard and Black Box? | [Charger routes](../csms/src/routes/charger.routes.ts) |
| Which parts of the EV view are simulated? | [Dashboard state and flow](../dashboard/app/page.tsx) and [styling](../dashboard/app/globals.css) |
| How is a default site created? | [Seed script](../csms/scripts/seed-site.ts) |
| How does a non-browser charger simulator work? | [CLI simulator](../csms/scripts/simulate-charger.ts) |
| What was actually tested end to end? | [Integration suite](../csms/tests/phase1.e2e.ts) and [test gate](../scripts/check-phase1.sh) |
| How is the local system packaged? | [Root Compose](../compose.yml) and component Dockerfiles under `csms/`, `dashboard/`, and `load-balancer/` |
