"use client";

import { FormEvent, useMemo, useState } from "react";

const CSMS_HTTP_URL =
    process.env.NEXT_PUBLIC_CSMS_HTTP_URL ?? "http://localhost:6773";

const BUILDING_LOAD_KW = [35, 40, 50, 55, 55, 45, 35, 25, 20, 25, 35, 45];
const SOLAR_GENERATION_KW = [0, 0, 0, 10, 20, 30, 35, 30, 20, 10, 0, 0];
const TARIFF_PAISE_PER_KWH = [700, 700, 800, 900, 1200, 1200, 1000, 800, 700, 800, 900, 900];

type ScenarioVehicle = {
    vehicleId: string;
    arrivalStep: number;
    departureStep: number;
    energyRequiredKwh: number;
    maxPowerKw: number;
    priority: number;
    batteryCapacityKwh: number;
    initialSocPct: number;
    targetSocPct: number;
};

type VehicleAllocation = {
    vehicleId: string;
    requestedPowerKw: number;
    allocatedPowerKw: number;
    reason: string;
};

type SimulationStep = {
    step: number;
    buildingLoadKw: number;
    solarGenerationKw: number;
    availableEvPowerKw: number;
    totalEvAllocationKw: number;
    siteImportKw: number;
    tariffPaisePerKwh: number;
    allocations: VehicleAllocation[];
};

type PolicyResult = {
    policyId: string;
    name: string;
    description: string;
    metrics: {
        totalEnergyDeliveredKwh: number;
        totalEnergyShortfallKwh: number;
        missedDeadlines: number;
        peakSiteImportKw: number;
        transformerUtilization: number;
        totalCostPaise: number;
        deliveryFairness: number;
        allocationChanges: number;
    };
    steps: SimulationStep[];
    vehicles: Array<{
        vehicleId: string;
        energyRequiredKwh: number;
        energyDeliveredKwh: number;
        energyShortfallKwh: number;
        missedDeadline: boolean;
        finalSocPct: number;
    }>;
};

type CompareResponse = {
    sitePowerLimitKw: number;
    timeStepMinutes: number;
    policies: PolicyResult[];
    constraint: string;
    costsAreModeled: boolean;
};

const DEFAULT_VEHICLES: ScenarioVehicle[] = [
    {
        vehicleId: "EV-01",
        arrivalStep: 0,
        departureStep: 8,
        energyRequiredKwh: 36,
        maxPowerKw: 40,
        priority: 0,
        batteryCapacityKwh: 72,
        initialSocPct: 30,
        targetSocPct: 80,
    },
    {
        vehicleId: "EV-02",
        arrivalStep: 1,
        departureStep: 5,
        energyRequiredKwh: 28,
        maxPowerKw: 50,
        priority: 1,
        batteryCapacityKwh: 60,
        initialSocPct: 35,
        targetSocPct: 82,
    },
    {
        vehicleId: "EV-03",
        arrivalStep: 2,
        departureStep: 10,
        energyRequiredKwh: 42,
        maxPowerKw: 60,
        priority: 0,
        batteryCapacityKwh: 82,
        initialSocPct: 40,
        targetSocPct: 91,
    },
    {
        vehicleId: "EV-04",
        arrivalStep: 3,
        departureStep: 7,
        energyRequiredKwh: 20,
        maxPowerKw: 30,
        priority: 2,
        batteryCapacityKwh: 48,
        initialSocPct: 28,
        targetSocPct: 70,
    },
    {
        vehicleId: "EV-05",
        arrivalStep: 5,
        departureStep: 12,
        energyRequiredKwh: 48,
        maxPowerKw: 60,
        priority: 0,
        batteryCapacityKwh: 90,
        initialSocPct: 25,
        targetSocPct: 78,
    },
    {
        vehicleId: "EV-06",
        arrivalStep: 6,
        departureStep: 11,
        energyRequiredKwh: 24,
        maxPowerKw: 40,
        priority: 1,
        batteryCapacityKwh: 64,
        initialSocPct: 42,
        targetSocPct: 80,
    },
];

function formatPower(value: number) {
    return `${value.toFixed(value % 1 === 0 ? 0 : 1)} kW`;
}

function formatCost(paise: number) {
    return `₹${(paise / 100).toFixed(0)}`;
}

function makeRequest(sitePowerLimitKw: number, vehicles: ScenarioVehicle[]) {
    return {
        sitePowerLimitKw,
        timeStepMinutes: 15,
        buildingLoadKw: BUILDING_LOAD_KW,
        solarGenerationKw: SOLAR_GENERATION_KW,
        tariffPaisePerKwh: TARIFF_PAISE_PER_KWH,
        demandChargePaisePerKw: 180,
        vehicles,
    };
}

function TimelineChart({
    policy,
    siteLimit,
}: {
    policy: PolicyResult;
    siteLimit: number;
}) {
    const width = 840;
    const height = 250;
    const chartTop = 24;
    const chartBottom = 190;
    const maxValue = Math.max(
        siteLimit,
        ...policy.steps.map((step) => step.siteImportKw),
        ...policy.steps.map((step) => step.availableEvPowerKw),
        1,
    );
    const scale = (value: number) =>
        (value / maxValue) * (chartBottom - chartTop);

    return (
        <svg
            className="lab-chart"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${policy.name} station load timeline`}
        >
            <line
                className="lab-chart-limit"
                x1="40"
                x2="810"
                y1={chartBottom - scale(siteLimit)}
                y2={chartBottom - scale(siteLimit)}
            />
            <text className="lab-chart-limit-label" x="42" y="18">
                {formatPower(siteLimit)} site limit
            </text>
            {policy.steps.map((step, index) => {
                const x = 52 + index * 64;
                const siteHeight = scale(step.siteImportKw);
                const evHeight = scale(step.totalEvAllocationKw);
                const availableHeight = scale(step.availableEvPowerKw);

                return (
                    <g key={step.step}>
                        <rect
                            className="lab-chart-available"
                            x={x}
                            y={chartBottom - availableHeight}
                            width="18"
                            height={availableHeight}
                            rx="3"
                        />
                        <rect
                            className="lab-chart-import"
                            x={x + 22}
                            y={chartBottom - siteHeight}
                            width="18"
                            height={siteHeight}
                            rx="3"
                        />
                        <rect
                            className="lab-chart-ev"
                            x={x + 44}
                            y={chartBottom - evHeight}
                            width="12"
                            height={evHeight}
                            rx="3"
                        />
                        <text className="lab-chart-step" x={x + 20} y="216">
                            {step.step + 1}
                        </text>
                    </g>
                );
            })}
            <text className="lab-chart-axis-label" x="52" y="238">
                time step · 15 minutes each
            </text>
        </svg>
    );
}

export default function OperationsLabPage() {
    const [siteLimitInput, setSiteLimitInput] = useState("100");
    const [vehicles, setVehicles] = useState(DEFAULT_VEHICLES);
    const [result, setResult] = useState<CompareResponse | null>(null);
    const [selectedPolicyId, setSelectedPolicyId] = useState("deadline-aware");
    const [selectedStep, setSelectedStep] = useState(3);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");

    const selectedPolicy =
        result?.policies.find((policy) => policy.policyId === selectedPolicyId) ??
        result?.policies[0];
    const selectedTimelineStep = selectedPolicy?.steps[selectedStep];

    const activeDecision = useMemo(() => {
        if (!selectedTimelineStep) return "Run the comparison to inspect a station decision.";
        const constrained = selectedTimelineStep.allocations.find(
            (allocation) =>
                allocation.allocatedPowerKw + 0.001 <
                allocation.requestedPowerKw,
        );
        return constrained
            ? `${constrained.vehicleId}: ${constrained.reason}`
            : "All active vehicles fit within the available EV capacity at this step.";
    }, [selectedTimelineStep]);

    function updateVehicle(
        vehicleId: string,
        field: keyof ScenarioVehicle,
        value: string,
    ) {
        setVehicles((current) =>
            current.map((vehicle) =>
                vehicle.vehicleId === vehicleId
                    ? {
                          ...vehicle,
                          [field]:
                              field === "vehicleId"
                                  ? value
                                  : Number(value),
                      }
                    : vehicle,
            ),
        );
    }

    async function runComparison(event?: FormEvent) {
        event?.preventDefault();
        const siteLimit = Number(siteLimitInput);
        if (!Number.isFinite(siteLimit) || siteLimit <= 0) {
            setError("Site limit must be a positive number.");
            return;
        }

        setRunning(true);
        setError("");
        try {
            const response = await fetch(
                `${CSMS_HTTP_URL}/api/simulation/compare`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(makeRequest(siteLimit, vehicles)),
                },
            );
            const body = (await response.json()) as
                | CompareResponse
                | { error?: string };
            if (!response.ok || !("policies" in body)) {
                throw new Error(
                    "error" in body
                        ? body.error ?? "Policy comparison failed"
                        : "Policy comparison failed",
                );
            }
            setResult(body);
            setSelectedStep(3);
        } catch (comparisonError) {
            setError(
                comparisonError instanceof Error
                    ? comparisonError.message
                    : "Policy evaluator unavailable.",
            );
        } finally {
            setRunning(false);
        }
    }

    return (
        <main className="lab-page">
            <header className="lab-header">
                <a className="lab-back" href="/">
                    ← Station simulator
                </a>
                <div>
                    <span className="lab-eyebrow">VOLTGRID · PHASE 2 ANALYSIS</span>
                    <h1>Charging Policy Comparison</h1>
                   <p>
                        The same station and vehicles, replayed through three
                        charging strategies.
                   </p>
                </div>
                <span className="lab-status">SIMULATION ONLY</span>
            </header>

            <section className="lab-intro">
                <div>
                    <span className="lab-section-label">THE PROBLEM</span>
                    <h2>
                        A station must meet driver deadlines without exceeding
                        its electrical connection.
                    </h2>
                </div>
                <p>
                    Building load and solar generation change the safe EV
                    capacity every 15 minutes. A policy can be fair, urgent,
                    or cost-aware—but it cannot optimize every objective at
                    once. This lab makes that trade-off visible.
                </p>
            </section>

            <div className="lab-layout">
                <aside className="lab-controls">
                    <div className="lab-panel-heading">
                        <span className="lab-section-label">01 · SCENARIO</span>
                        <strong>Station constraints</strong>
                    </div>
                    <form onSubmit={runComparison}>
                        <label>
                            Site import limit (kW)
                            <input
                                type="number"
                                min="1"
                                step="1"
                                value={siteLimitInput}
                                onChange={(event) =>
                                    setSiteLimitInput(event.target.value)
                                }
                            />
                        </label>
                        <div className="lab-readonly-row">
                            <span>Time horizon</span>
                            <strong>12 × 15 min</strong>
                        </div>
                        <div className="lab-readonly-row">
                            <span>Building load</span>
                            <strong>20–55 kW</strong>
                        </div>
                        <div className="lab-readonly-row">
                            <span>Solar profile</span>
                            <strong>0–35 kW</strong>
                        </div>
                        <button className="lab-run-button" type="submit" disabled={running}>
                            {running ? "Running policies…" : "Run policy comparison"}
                        </button>
                    </form>

                    <div className="lab-panel-heading lab-vehicles-heading">
                        <span className="lab-section-label">02 · FLEET</span>
                        <strong>Vehicle deadlines</strong>
                    </div>
                    <div className="lab-vehicle-list">
                        {vehicles.map((vehicle) => (
                            <div className="lab-vehicle-row" key={vehicle.vehicleId}>
                                <strong>{vehicle.vehicleId}</strong>
                                <label>
                                    Need
                                    <input
                                        type="number"
                                        min="0"
                                        step="1"
                                        value={vehicle.energyRequiredKwh}
                                        onChange={(event) =>
                                            updateVehicle(
                                                vehicle.vehicleId,
                                                "energyRequiredKwh",
                                                event.target.value,
                                            )
                                        }
                                    />
                                    <small>kWh</small>
                                </label>
                                <label>
                                    Leave
                                    <input
                                        type="number"
                                        min={vehicle.arrivalStep + 1}
                                        max="12"
                                        step="1"
                                        value={vehicle.departureStep}
                                        onChange={(event) =>
                                            updateVehicle(
                                                vehicle.vehicleId,
                                                "departureStep",
                                                event.target.value,
                                            )
                                        }
                                    />
                                    <small>step</small>
                                </label>
                            </div>
                        ))}
                    </div>
                </aside>

                <section className="lab-results">
                    {error ? <p className="lab-error">{error}</p> : null}
                    {!result ? (
                        <div className="lab-empty">
                            <span>READY TO RUN</span>
                            <h2>Turn the station into an experiment.</h2>
                            <p>
                                Run the default six-vehicle scenario to compare
                                first-come, equal-share, and deadline-aware
                                scheduling.
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="lab-policy-tabs" role="tablist">
                                {result.policies.map((policy) => (
                                    <button
                                        key={policy.policyId}
                                        type="button"
                                        className={
                                            policy.policyId ===
                                            selectedPolicy?.policyId
                                                ? "is-active"
                                                : ""
                                        }
                                        onClick={() =>
                                            setSelectedPolicyId(policy.policyId)
                                        }
                                    >
                                        <span>{policy.name}</span>
                                        <small>
                                            {policy.metrics.missedDeadlines} missed
                                        </small>
                                    </button>
                                ))}
                            </div>

                            {selectedPolicy ? (
                                <>
                                    <div className="lab-policy-heading">
                                        <div>
                                            <span className="lab-section-label">
                                                SELECTED POLICY
                                            </span>
                                            <h2>{selectedPolicy.name}</h2>
                                            <p>{selectedPolicy.description}</p>
                                        </div>
                                        <span className="lab-constraint">
                                            Σ site import ≤{" "}
                                            {formatPower(result.sitePowerLimitKw)}
                                        </span>
                                    </div>

                                    <div className="lab-metrics">
                                        <div>
                                            <span>Deadline misses</span>
                                            <strong>
                                                {selectedPolicy.metrics.missedDeadlines}
                                            </strong>
                                        </div>
                                        <div>
                                            <span>Energy delivered</span>
                                            <strong>
                                                {selectedPolicy.metrics.totalEnergyDeliveredKwh.toFixed(
                                                    1,
                                                )}{" "}
                                                kWh
                                            </strong>
                                        </div>
                                        <div>
                                            <span>Peak site import</span>
                                            <strong>
                                                {formatPower(
                                                    selectedPolicy.metrics.peakSiteImportKw,
                                                )}
                                            </strong>
                                        </div>
                                        <div>
                                            <span>Modeled cost</span>
                                            <strong>
                                                {formatCost(
                                                    selectedPolicy.metrics.totalCostPaise,
                                                )}
                                            </strong>
                                        </div>
                                    </div>

                                    <div className="lab-chart-panel">
                                        <div className="lab-chart-heading">
                                            <span>TIME-STEP REPLAY</span>
                                            <small>
                                                {selectedPolicy.metrics.allocationChanges}{" "}
                                                allocation changes
                                            </small>
                                        </div>
                                        <TimelineChart
                                            policy={selectedPolicy}
                                            siteLimit={result.sitePowerLimitKw}
                                        />
                                        <div className="lab-chart-legend">
                                            <span><i className="available" /> Available EV capacity</span>
                                            <span><i className="import" /> Grid import</span>
                                            <span><i className="ev" /> EV allocation</span>
                                        </div>
                                    </div>

                                    <div className="lab-replay">
                                        <label htmlFor="lab-step">
                                            Inspect decision at time step{" "}
                                            <strong>{selectedStep + 1}</strong>
                                        </label>
                                        <input
                                            id="lab-step"
                                            type="range"
                                            min="0"
                                            max={selectedPolicy.steps.length - 1}
                                            value={selectedStep}
                                            onChange={(event) =>
                                                setSelectedStep(Number(event.target.value))
                                            }
                                        />
                                        <div className="lab-step-summary">
                                            <span>
                                                Building{" "}
                                                <strong>
                                                    {formatPower(
                                                        selectedTimelineStep?.buildingLoadKw ??
                                                            0,
                                                    )}
                                                </strong>
                                            </span>
                                            <span>
                                                Solar{" "}
                                                <strong>
                                                    {formatPower(
                                                        selectedTimelineStep?.solarGenerationKw ??
                                                            0,
                                                    )}
                                                </strong>
                                            </span>
                                            <span>
                                                EV capacity{" "}
                                                <strong>
                                                    {formatPower(
                                                        selectedTimelineStep?.availableEvPowerKw ??
                                                            0,
                                                    )}
                                                </strong>
                                            </span>
                                            <span>
                                                EV allocated{" "}
                                                <strong>
                                                    {formatPower(
                                                        selectedTimelineStep?.totalEvAllocationKw ??
                                                            0,
                                                    )}
                                                </strong>
                                            </span>
                                        </div>
                                        <p className="lab-decision">
                                            <span>WHY THIS HAPPENED</span>
                                            {activeDecision}
                                        </p>
                                    </div>

                                    <div className="lab-comparison">
                                        <div className="lab-chart-heading">
                                            <span>POLICY TRADE-OFF</span>
                                            <small>same input · different objective</small>
                                        </div>
                                        {result.policies.map((policy) => (
                                            <button
                                                type="button"
                                                key={policy.policyId}
                                                onClick={() =>
                                                    setSelectedPolicyId(policy.policyId)
                                                }
                                            >
                                                <strong>{policy.name}</strong>
                                                <span>
                                                    {policy.metrics.missedDeadlines} misses ·{" "}
                                                    {policy.metrics.totalEnergyShortfallKwh.toFixed(
                                                        1,
                                                    )}{" "}
                                                    kWh shortfall ·{" "}
                                                    {formatCost(policy.metrics.totalCostPaise)}
                                                </span>
                                                <i
                                                    style={{
                                                        width: `${Math.min(
                                                            100,
                                                            policy.metrics.deliveryFairness * 100,
                                                        )}%`,
                                                    }}
                                                />
                                            </button>
                                        ))}
                                    </div>
                                </>
                            ) : null}
                        </>
                    )}
                </section>
            </div>
        </main>
    );
}
