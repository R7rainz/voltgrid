# Supervisor demo phases

The project is built continuously, but the demonstration can be presented in
two phases.

## Phase 1: working CSMS foundation

Show the supervisor:

1. Start PostgreSQL/Neon, the Hono CSMS, and the Next.js dashboard.
2. Add four simulated chargers with unique IDs.
3. Connect a charger and show BootNotification acceptance.
4. Show `Available`, `Preparing`, and `Charging` state changes.
5. Start a session and show the transaction ID.
6. Send meter values using `+1 kWh` or **Run full demo**.
7. Stop the session and show the generated INR invoice.
8. Refresh the dashboard or query PostgreSQL to show that the session and
   invoice are durable records.
9. Start all four sessions at a `100 kW` site. Show the unmanaged first-come
   result: `50 kW`, `50 kW`, `0 kW`, `0 kW`, with `100 kW` unmet demand.
   Requests are granted whole or not at all; with three `40 kW` cars the
   result is `40 kW`, `40 kW`, `0 kW`, leaving `20 kW` unused and one full
   request unmet. The Go allocator remains unused in Phase 1.

The key claim for Phase 1 is: VoltGrid can manage multiple simulated chargers,
charging sessions, meter readings, and billing without physical vehicle
hardware, while clearly demonstrating why smart load balancing is required.

## Phase 2: smart charging (this branch)

Show the supervisor:

1. Run `docker compose up --build -d` and verify the Go service at
   `http://localhost:8787/health`.
2. Add three cars requesting `40 kW` each and start their sessions manually.
3. Show that Hono reads the `100 kW` site capacity from PostgreSQL, sends
   active demands to Go `/v1/allocate`, then sends each returned limit to the
   simulated charger with `SetChargingProfile`.
4. All three cards should settle near `33.33 kW`; together they stay under
   `100 kW`. This differs from Phase 1's `40`, `40`, `0 kW` baseline.
5. Change a car's demand or the site capacity and show another live
   recalculation; restore the three `40 kW` requests at a `100 kW` site.
6. For the **VoltGrid Black Box** scenario, keep all three sessions open
   and press **Inject fault** on one car. Its simulator sends OCPP
   `StatusNotification(Faulted, PowerSwitchFailure)`. The CSMS targets `0 kW`
   for that connector before raising the healthy chargers to `40 kW` each.
   Meter readings reported during the fault are rejected, so they do not
   increase billable energy. Press **Recover charger** to report `Charging`
   with `NoError`; all three shares return to about `33.33 kW`.
7. Select the faulted car and use **Replay**, **Next**, and **Latest** in the
   Black Box panel. The read-only timeline comes from durable OCPP status
   messages and acknowledged outbound charging profiles in PostgreSQL. It
   does not resend commands or alter a session.
8. Stop one session and show the remaining two rise to `40 kW` each. Add meter
   values, stop the remaining sessions, and show the invoices. The payment
   button is a mock UI confirmation, not a payment-gateway charge.

The browser represents chargers rather than physical vehicles. The charging
profiles are acknowledged by this simulator; real charger compatibility and
electrical enforcement are not claimed.
The injected fault and recovery are simulator actions, not hardware diagnostics
or automatic repair. The CSMS will not increase other cars' profiles if the
faulted charger fails to acknowledge the 0 kW profile.

## Questions to prepare for

- **Why PostgreSQL?** It stores durable operational and billing history.
- **Why Redis later?** Live state and pub/sub do not need to be durable.
- **Why Go?** The allocation calculation is isolated as a small, fast service
  with no runtime dependencies.
- **How is capacity protected?** The allocator validates inputs and water-fills
  active demand without allowing total allocation above the site limit.
- **How is this tested without a car?** The dashboard and CLI simulator produce
  repeatable charger traffic through the same backend WebSocket route.
