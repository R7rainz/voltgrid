# VoltGrid Grid Operations Lab

## The real problem

An EV charging station is not just a collection of plug-and-play chargers.
Every charger shares a constrained electrical connection to the site. The
station may also be serving a building, receiving variable solar generation,
operating under time-varying tariffs, and trying to meet each driver's
departure requirement.

The engineering problem is:

> Given a changing set of EVs, a finite site connection, non-charging building
> load, renewable generation, tariffs, and vehicle deadlines, how should the
> station decide who receives how much power at each time step?

A poor policy creates several visible failures:

- The first vehicle can consume the available capacity while later vehicles
  miss their departure targets.
- Equal sharing can look fair at one instant while still failing the vehicle
  with the closest deadline.
- Charging during a site peak increases the station's modeled demand cost and
  can make a connection upgrade appear necessary.
- A policy that maximizes energy delivered can still produce an unacceptable
  user experience if it ignores waiting time, state of charge, or departure
  urgency.
- Operators need to understand *why* a vehicle was throttled. A number such
  as "33.33 kW" is not an explanation.

VoltGrid should therefore demonstrate a constrained scheduling decision, not
only arithmetic that divides a site limit.

## The proposed feature: Grid Operations Lab

The Grid Operations Lab is a deterministic digital-twin-style simulator
inside VoltGrid. An operator creates one station scenario and runs the same
scenario against several charging policies. The UI then shows the policies
side by side over the same timeline.

The scenario contains:

- Site import limit and transformer utilization.
- Non-EV building load for each time step.
- Optional solar generation for each time step.
- Energy tariff for each time step.
- Modeled peak-demand charge.
- EV arrival and departure time steps.
- Battery capacity, initial state of charge, target state of charge, and
  maximum charging power.
- Energy required by the vehicle before departure.
- Optional priority and waiting-time weights.

The simulation is intentionally transparent. It is a planning model and
replayable software experiment, not a claim about physical power delivery or
an electrical-safety cutoff.

## Policies to compare

### 1. Unmanaged first-come-first-served baseline

The oldest active vehicle receives its requested power first. Remaining
capacity is passed to the next vehicle.

This is easy to understand and is useful as a control condition. It can
under-serve late arrivals, miss deadlines, and leave capacity stranded when
the first vehicle does not need the full share.

### 2. Equal-share max-min fairness

The current VoltGrid water-filling allocator gives every active vehicle an
equal share, while capping vehicles whose demand is lower than that share.

This protects instantaneous fairness and keeps total allocation under the
site limit. It does not know which vehicle is leaving soon, whether a vehicle
has a large energy deficit, or whether the current time is expensive.

### 3. Deadline-aware weighted allocation

The proposed policy computes an urgency score for each active vehicle:

~~~
energy deficit / remaining time to departure
~~~

The score is combined with priority and waiting time, then used as a weight
in a capped allocation. A vehicle with little time remaining and a large
deficit receives more of the available power, while every allocation remains
bounded by the vehicle and site limits.

This policy should reduce deadline misses, but it can be less equal than
water-filling. That trade-off is measured rather than hidden.

### 4. Peak-aware cost policy

The peak-aware policy treats available site capacity as a time-dependent
resource. It favours lower-cost time steps when a vehicle can still meet its
deadline, while reserving enough power for urgent vehicles.

This policy should reduce modeled energy and demand cost, but it can delay
charging and increase the risk of deadline misses when forecasts are wrong.
It is a planning policy in the simulator, not a dynamic market-price or
utility-control integration.

The first implementation can ship policies 1–3 as the minimum comparison
experiment. Policy 4 should be added only when the same input and metric
contracts are already stable.

## What the simulation must prove

Every policy receives the same scenario. The simulator reports:

- Total energy delivered.
- Energy shortfall at each departure.
- Number of missed vehicle targets.
- Maximum site import.
- Transformer utilization.
- Modeled energy cost.
- Modeled peak-demand cost.
- Total modeled station cost.
- Jain-style delivery fairness.
- Number of allocation changes.
- Per-vehicle timeline of requested, allocated, and delivered power.

The primary constraint is:

~~~
building load + EV allocation - solar generation
    <= configured site import limit
~~~

The simulator must reject invalid input and must never return a policy result
that violates the configured site limit.

Costs are configurable model parameters. The demo must label them as modeled
costs and must not present them as current utility tariffs or a real
infrastructure quotation.

## Supervisor-facing demonstration

Use one repeatable scenario so the comparison is easy to explain:

~~~
Site import limit: 100 kW
Simulation horizon: 12 time steps
Time step: 15 minutes
Building load: 20–55 kW across the day
Solar generation: 0–35 kW during the middle steps
Vehicles: 6
Vehicle requests: 20–60 kW
Each vehicle has a different arrival and departure window
Each vehicle has a different energy deficit
~~~

The visible sequence is:

1. A station timeline shows building load, solar, EV demand, and the
   remaining safe EV capacity.
2. Six vehicles arrive at different times with a target and departure
   deadline.
3. The operator selects a policy and starts the simulation.
4. The station replays each time step. Each vehicle's allocated power and
   state of charge change on screen.
5. The policy comparison table updates in parallel.
6. A vehicle card explains decisions in plain language, for example:
   "Reduced to 12 kW: 55 kW building load leaves 45 kW for EVs; two vehicles
   have earlier departures."
7. The final view ranks policies by the selected objective and displays the
   trade-off, such as:
   "Deadline-aware: fewer missed targets, higher modeled peak cost."

This makes the station's decision process observable to a reviewer who does
not need to understand every OCPP message.

## Why this is a stronger project problem

The project becomes a multi-objective control and scheduling study:

- It has a real shared-resource constraint.
- It includes competing goals instead of one output number.
- It compares a baseline with multiple strategies.
- It produces repeatable evidence from identical inputs.
- It exposes the drawbacks of each strategy.
- It connects protocol events to an operator-level decision.
- It can be extended later with measured charger limits, storage,
  forecasting, or real utility data without changing the experiment's core
  contract.

The contribution should be described as an explainable, reproducible charging
policy comparison layer for a CSMS simulator. It should not be described as a
new optimization algorithm unless a formal research evaluation establishes
that claim.

## Implementation boundary

The existing OCPP-style flow remains the integration path:

~~~
Dashboard scenario controls
        -> Hono CSMS scenario API
        -> Go policy evaluator
        -> time-step results
        -> dashboard replay and comparison
~~~

The evaluator remains stateless and does not read PostgreSQL or speak OCPP.
The CSMS remains responsible for HTTP, charger state, OCPP connections,
durable sessions, invoices, and live profile orchestration. The lab's
scenario and result history can initially remain in memory; durable experiment
storage should be added only if the supervisor needs replay across restarts.

## Acceptance criteria

- One scenario can be run with at least three policies using identical input.
- The result contains per-step allocations for every vehicle and policy.
- Every result satisfies the site import constraint.
- The UI visibly shows demand, available capacity, allocation, and shortfall.
- The UI explains at least one policy decision in plain language.
- The comparison shows at least three meaningful metrics and their units.
- Tests cover invalid input, capacity safety, deadline accounting, and a
  scenario where the policies produce different outcomes.
- The documentation labels modeled cost, simulated telemetry, and
  simulator-only profile acknowledgements.

## What is deliberately not claimed

VoltGrid does not currently claim physical charger control, certified OCPP
conformance, utility billing accuracy, real-time electricity-market
participation, battery-health estimation, or a guaranteed financial saving.
Those require hardware, utility data, authenticated users, and separate
validation.
