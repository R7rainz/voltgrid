# Supervisor demo phases

The project is built continuously, but the demonstration can be presented in
two phases.

## Phase 1: working CSMS foundation

Show the supervisor:

1. Start PostgreSQL/Neon, the Hono CSMS, and the Next.js dashboard.
2. Add two or three simulated chargers with unique IDs.
3. Connect a charger and show BootNotification acceptance.
4. Show `Available`, `Preparing`, and `Charging` state changes.
5. Start a session and show the transaction ID.
6. Send meter values using `+1 kWh` or **Run full demo**.
7. Stop the session and show the generated INR invoice.
8. Query PostgreSQL to show that the session and invoice are durable records.
   The current browser simulator cards are local to the dashboard tab, so a
   refresh clears those cards even though the backend records remain stored.

The key claim for Phase 1 is: VoltGrid can manage multiple simulated chargers,
charging sessions, meter readings, and billing without physical vehicle
hardware.

## Phase 2: smart charging

Show the supervisor:

1. Start the Go service and open its health endpoint.
2. Run two or more active sessions in the same site.
3. Explain that Hono reads `Site.powerLimitKw` from PostgreSQL.
4. Show Hono calling the Go `/v1/allocate` contract.
5. Use a simple example such as a `100 kW` site with two chargers requesting
   `80 kW` each; the allocator returns `50 kW` each and `100 kW` total.
6. Show each simulator acknowledging the outbound charging-profile command and
   displaying its applied allocation.
7. Repeat after one charger stops and show that the active set is recalculated.

The Phase 2 implementation demonstrates the allocation decision, capacity
guarantee, outbound command round trip, and dashboard update. It does not claim
physical power control.

## Questions to prepare for

- **Why PostgreSQL?** It stores durable operational and billing history.
- **Why Redis later?** Live state and pub/sub do not need to be durable.
- **Why Go?** The allocation calculation is isolated as a small, fast service
  with no runtime dependencies.
- **How is capacity protected?** The allocator validates inputs and water-fills
  active demand without allowing total allocation above the site limit.
- **How is this tested without a car?** The dashboard and CLI simulator produce
  repeatable charger traffic through the same backend WebSocket route.
