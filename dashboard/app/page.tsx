"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

const CSMS_HTTP_URL =
    process.env.NEXT_PUBLIC_CSMS_HTTP_URL ?? "http://localhost:6773";
const CSMS_WS_URL =
    process.env.NEXT_PUBLIC_CSMS_WS_URL ?? "ws://localhost:6773";
const DEFAULT_SITE_CAPACITY_KW = 100;
const CHARGER_MAX_POWER_KW = 50;

type ChargerStatus =
    | "Offline"
    | "Connecting"
    | "Available"
    | "Preparing"
    | "Charging"
    | "Error";

type Invoice = {
    id: number;
    sessionId: number;
    energyWh: number;
    tariffPaisePerKwh: number;
    amountPaise: number;
    currency: string;
    status: string;
    issuedAt: string;
    energyKwh: number;
    amountInr: string;
};

type SimulatedCharger = {
    id: string;
    idTag: string;
    connectorId: number;
    status: ChargerStatus;
    meterWh: number;
    transactionId?: number;
    invoice?: Invoice;
    allocatedPowerKw?: number;
    error?: string;
};

type SiteSummary = {
    id: number;
    name: string;
    powerLimitKw: number;
    tariffPaisePerKwh: number;
};

type PendingRequest = {
    chargerId: string;
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatWh(meterWh: number) {
    return `${(meterWh / 1000).toFixed(1)} kWh`;
}

function formatPower(powerKw: number) {
    return `${powerKw.toFixed(powerKw % 1 === 0 ? 0 : 1)} kW`;
}

function getProfileLimitKw(payload: unknown) {
    if (!isObject(payload) || !isObject(payload.csChargingProfiles)) {
        return 0;
    }

    const schedule = payload.csChargingProfiles.chargingSchedule;

    if (!isObject(schedule) || !Array.isArray(schedule.chargingSchedulePeriod)) {
        return 0;
    }

    const firstPeriod = schedule.chargingSchedulePeriod[0];

    if (
        !isObject(firstPeriod) ||
        typeof firstPeriod.limit !== "number" ||
        !Number.isFinite(firstPeriod.limit)
    ) {
        return 0;
    }

    return Math.max(0, firstPeriod.limit / 1000);
}

export default function Home() {
    const [chargers, setChargers] = useState<SimulatedCharger[]>([]);
    const [backendOnline, setBackendOnline] = useState(false);
    const [site, setSite] = useState<SiteSummary | null>(null);
    const [demoStatus, setDemoStatus] = useState("Waiting for a vehicle");
    const [powerLimitInput, setPowerLimitInput] = useState("");
    const [tariffInput, setTariffInput] = useState("");
    const [siteSaveMessage, setSiteSaveMessage] = useState("");
    const [savingSite, setSavingSite] = useState(false);
    const [chargerId, setChargerId] = useState("demo-car-001");
    const [idTag, setIdTag] = useState("DEMO-DRIVER-001");
    const [connectorId, setConnectorId] = useState("1");
    const sockets = useRef(new Map<string, WebSocket>());
    const pending = useRef(new Map<string, PendingRequest>());
    const chargersRef = useRef(chargers);
    const requestNumber = useRef(0);

    useEffect(() => {
        chargersRef.current = chargers;
    }, [chargers]);

    useEffect(() => {
        let cancelled = false;

        const refresh = async () => {
            try {
                const [chargerResponse, siteResponse] = await Promise.all([
                    fetch(`${CSMS_HTTP_URL}/api/chargers`, {
                        cache: "no-store",
                    }),
                    fetch(`${CSMS_HTTP_URL}/api/site`, {
                        cache: "no-store",
                    }),
                ]);

                if (!chargerResponse.ok) {
                    throw new Error("CSMS request failed");
                }

                if (!cancelled) {
                    if (siteResponse.ok) {
                        const siteData = (await siteResponse.json()) as {
                            site?: SiteSummary;
                        };

                        if (siteData.site) {
                            setSite(siteData.site);
                            setPowerLimitInput((current) =>
                                current || String(siteData.site?.powerLimitKw ?? ""),
                            );
                            setTariffInput((current) =>
                                current || String((siteData.site?.tariffPaisePerKwh ?? 0) / 100),
                            );
                        }
                    }

                    setBackendOnline(true);
                }
            } catch {
                if (!cancelled) {
                    setBackendOnline(false);
                }
            }
        };

        void refresh();
        const interval = setInterval(refresh, 2000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, []);

    useEffect(() => {
        return () => {
            for (const socket of sockets.current.values()) {
                socket.close();
            }

            for (const request of pending.current.values()) {
                clearTimeout(request.timeout);
                request.reject(new Error("Dashboard closed"));
            }
        };
    }, []);

    function updateCharger(id: string, patch: Partial<SimulatedCharger>) {
        const nextChargers = chargersRef.current.map((charger) =>
            charger.id === id ? { ...charger, ...patch } : charger,
        );

        chargersRef.current = nextChargers;
        setChargers(nextChargers);
    }

    function rejectPendingForCharger(id: string, error: Error) {
        for (const [uniqueId, request] of pending.current) {
            if (request.chargerId !== id) {
                continue;
            }

            clearTimeout(request.timeout);
            request.reject(error);
            pending.current.delete(uniqueId);
        }
    }

    function sendCall(
        id: string,
        action: string,
        payload: Record<string, unknown>,
    ) {
        const socket = sockets.current.get(id);

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("Charger is not connected"));
        }

        const uniqueId = `dashboard-${++requestNumber.current}`;

        return new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pending.current.delete(uniqueId);
                reject(new Error(`Timed out waiting for ${action}`));
            }, 30_000);

            pending.current.set(uniqueId, {
                chargerId: id,
                resolve,
                reject,
                timeout,
            });

            socket.send(JSON.stringify([2, uniqueId, action, payload]));
        });
    }

    function handleMessage(id: string, event: MessageEvent) {
        if (typeof event.data !== "string") {
            return;
        }

        let message: unknown;

        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }

        if (!Array.isArray(message) || message.length < 3) {
            return;
        }

        const [messageType, uniqueId, messagePayload] = message;
        const action = message[2];

        if (messageType === 2 && typeof uniqueId === "string" && typeof action === "string") {
            const socket = sockets.current.get(id);

            if (!socket || socket.readyState !== WebSocket.OPEN) {
                return;
            }

            if (action === "SetChargingProfile") {
                const allocatedPowerKw = getProfileLimitKw(message[3]);
                updateCharger(id, { allocatedPowerKw });
                setDemoStatus(`${id} power profile applied · ${formatPower(allocatedPowerKw)}`);
                socket.send(JSON.stringify([3, uniqueId, { status: "Accepted" }]));
                return;
            }

            socket.send(
                JSON.stringify([
                    4,
                    uniqueId,
                    "NotSupported",
                    `${action} is not implemented by the browser simulator`,
                    {},
                ]),
            );
            return;
        }

        if ((messageType !== 3 && messageType !== 4) || typeof uniqueId !== "string") {
            return;
        }

        const request = pending.current.get(uniqueId);

        if (!request) {
            return;
        }

        clearTimeout(request.timeout);
        pending.current.delete(uniqueId);

        if (messageType === 4) {
            request.reject(new Error(`${message[2]}: ${message[3] ?? "unknown error"}`));
            return;
        }

        request.resolve(messagePayload);
        updateCharger(id, { error: undefined });
    }

    async function connectCharger(id: string) {
        if (sockets.current.get(id)?.readyState === WebSocket.OPEN) {
            return;
        }

        const charger = chargersRef.current.find((item) => item.id === id);

        if (!charger) {
            return;
        }

        setDemoStatus(`Opening OCPP link · ${id}`);
        updateCharger(id, { status: "Connecting", error: undefined });

        const socket = new WebSocket(
            `${CSMS_WS_URL}/ocpp/${encodeURIComponent(charger.id)}`,
        );
        sockets.current.set(id, socket);

        socket.onmessage = (event) => handleMessage(id, event);

        return new Promise<void>((resolve, reject) => {
            let settled = false;

            const fail = (error: Error) => {
                updateCharger(id, { status: "Error", error: error.message });

                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };

            socket.onerror = () => fail(new Error("WebSocket connection failed"));
            socket.onclose = () => {
                sockets.current.delete(id);
                rejectPendingForCharger(id, new Error("Charger disconnected"));
                updateCharger(id, { status: "Offline" });
            };

            socket.onopen = async () => {
                try {
                    const bootResponse = await sendCall(id, "BootNotification", {
                        chargePointVendor: "VoltGrid Simulator",
                        chargePointModel: "Browser Charger",
                    });

                    if (!isObject(bootResponse) || bootResponse.status !== "Accepted") {
                        throw new Error("BootNotification was rejected");
                    }

                    await sendCall(id, "StatusNotification", {
                        connectorId: charger.connectorId,
                        status: "Available",
                        errorCode: "NoError",
                    });

                    updateCharger(id, { status: "Available" });
                    setDemoStatus(`${id} online · connector available`);

                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                } catch (error) {
                    const reason = error instanceof Error ? error : new Error(String(error));
                    fail(reason);
                    socket.close();
                }
            };
        });
    }

    async function startSession(id: string) {
        const charger = chargersRef.current.find((item) => item.id === id);

        if (!charger) {
            return;
        }

        try {
            setDemoStatus(`Authorising ${id} · starting session`);
            updateCharger(id, { status: "Preparing", error: undefined });

            await sendCall(id, "StatusNotification", {
                connectorId: charger.connectorId,
                status: "Preparing",
                errorCode: "NoError",
            });

            const response = await sendCall(id, "StartTransaction", {
                connectorId: charger.connectorId,
                idTag: charger.idTag,
                meterStart: charger.meterWh,
                timestamp: new Date().toISOString(),
            });

            if (
                !isObject(response) ||
                response.idTagInfo === undefined ||
                !isObject(response.idTagInfo) ||
                response.idTagInfo.status !== "Accepted" ||
                typeof response.transactionId !== "number"
            ) {
                throw new Error("StartTransaction was rejected");
            }

            await sendCall(id, "StatusNotification", {
                connectorId: charger.connectorId,
                status: "Charging",
                errorCode: "NoError",
            });

            updateCharger(id, {
                status: "Charging",
                transactionId: response.transactionId,
            });
            setDemoStatus(`${id} charging · load balancer engaged`);
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                error: error instanceof Error ? error.message : String(error),
            });
            setDemoStatus(`${id} session failed`);
        }
    }

    async function addEnergy(id: string) {
        const charger = chargersRef.current.find((item) => item.id === id);

        if (!charger?.transactionId || charger.status !== "Charging") {
            return;
        }

        const meterWh = charger.meterWh + 1000;

        try {
            await sendCall(id, "MeterValues", {
                connectorId: charger.connectorId,
                transactionId: charger.transactionId,
                meterValue: [
                    {
                        timestamp: new Date().toISOString(),
                        sampledValue: [
                            {
                                value: String(meterWh),
                                measurand: "Energy.Active.Import.Register",
                                unit: "Wh",
                            },
                        ],
                    },
                ],
            });

            updateCharger(id, { meterWh });
            setDemoStatus(`${id} meter updated · +1.0 kWh recorded`);
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async function stopSession(id: string) {
        const charger = chargersRef.current.find((item) => item.id === id);

        if (!charger?.transactionId || charger.status !== "Charging") {
            return;
        }

        try {
            setDemoStatus(`Closing ${id} · final meter and invoice`);
            const response = await sendCall(id, "StopTransaction", {
                transactionId: charger.transactionId,
                meterStop: charger.meterWh,
                timestamp: new Date().toISOString(),
                reason: "Local",
            });

            if (
                !isObject(response) ||
                !isObject(response.idTagInfo) ||
                response.idTagInfo.status !== "Accepted"
            ) {
                throw new Error("StopTransaction was rejected");
            }

            const invoiceResponse = await fetch(
                `${CSMS_HTTP_URL}/api/sessions/${charger.transactionId}/invoice`,
                { cache: "no-store" },
            );

            if (!invoiceResponse.ok) {
                throw new Error("Invoice was not generated");
            }

            const invoiceData = (await invoiceResponse.json()) as { invoice?: Invoice };

            if (!invoiceData.invoice) {
                throw new Error("Invoice response was empty");
            }

            await sendCall(id, "StatusNotification", {
                connectorId: charger.connectorId,
                status: "Available",
                errorCode: "NoError",
            });

            updateCharger(id, { status: "Available", invoice: invoiceData.invoice });
            setDemoStatus(`${id} complete · invoice issued`);
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                error: error instanceof Error ? error.message : String(error),
            });
            setDemoStatus(`${id} session failed to close`);
        }
    }

    async function runDemo(id: string) {
        try {
            setDemoStatus(`Vehicle arrival sequence · ${id}`);

            if (sockets.current.get(id)?.readyState !== WebSocket.OPEN) {
                await connectCharger(id);
            }

            await startSession(id);
            await new Promise((resolve) => setTimeout(resolve, 350));
            await addEnergy(id);
            await new Promise((resolve) => setTimeout(resolve, 350));
            await addEnergy(id);
            await stopSession(id);
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                error: error instanceof Error ? error.message : String(error),
            });
            setDemoStatus(`${id} demo sequence failed`);
        }
    }

    function addCharger(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (chargersRef.current.length >= 4) {
            setDemoStatus("Station full · remove a vehicle before adding another");
            return;
        }

        const id = chargerId.trim();
        const tag = idTag.trim();
        const connector = Number(connectorId);

        if (
            !id ||
            !tag ||
            !Number.isInteger(connector) ||
            connector < 1 ||
            chargersRef.current.some((charger) => charger.id === id)
        ) {
            return;
        }

        const nextCharger: SimulatedCharger = {
            id,
            idTag: tag,
            connectorId: connector,
            status: "Offline",
            meterWh: 100_000,
        };
        const nextChargers = [...chargersRef.current, nextCharger];

        chargersRef.current = nextChargers;
        setChargers(nextChargers);
        setDemoStatus(`${id} entering the site · ready to connect`);

        setChargerId(`demo-car-${String(nextChargers.length + 1).padStart(3, "0")}`);
        setIdTag(`DEMO-DRIVER-${String(nextChargers.length + 1).padStart(3, "0")}`);
    }

    function disconnectCharger(id: string) {
        sockets.current.get(id)?.close();
        sockets.current.delete(id);
        updateCharger(id, { status: "Offline" });
        setDemoStatus(`${id} disconnected · site capacity released`);
    }

    function removeCharger(id: string) {
        disconnectCharger(id);
        const nextChargers = chargersRef.current.filter((charger) => charger.id !== id);
        chargersRef.current = nextChargers;
        setChargers(nextChargers);
    }

    async function saveSiteSettings(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const powerLimitKw = Number(powerLimitInput);
        const tariffInrPerKwh = Number(tariffInput);

        if (
            !Number.isFinite(powerLimitKw) ||
            powerLimitKw < 0 ||
            !Number.isFinite(tariffInrPerKwh) ||
            tariffInrPerKwh < 0
        ) {
            setSiteSaveMessage("Enter valid non-negative numbers.");
            return;
        }

        setSavingSite(true);
        setSiteSaveMessage("");

        try {
            const response = await fetch(`${CSMS_HTTP_URL}/api/site`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    powerLimitKw,
                    tariffPaisePerKwh: Math.round(tariffInrPerKwh * 100),
                }),
            });

            const data = (await response.json()) as {
                site?: SiteSummary;
                error?: string;
            };

            if (!response.ok || !data.site) {
                throw new Error(data.error ?? "Could not save station settings");
            }

            setSite(data.site);
            setPowerLimitInput(String(data.site.powerLimitKw));
            setTariffInput(String(data.site.tariffPaisePerKwh / 100));
            setSiteSaveMessage("Station settings saved");
            setDemoStatus("Station settings updated · new sessions use this tariff");
        } catch (error) {
            setSiteSaveMessage(error instanceof Error ? error.message : String(error));
        } finally {
            setSavingSite(false);
        }
    }

    const siteCapacityKw = site?.powerLimitKw ?? DEFAULT_SITE_CAPACITY_KW;
    const chargingCount = chargers.filter(
        (charger) => charger.status === "Charging",
    ).length;
    const projectedDemandKw = chargingCount * CHARGER_MAX_POWER_KW;
    const reportedAllocations = chargers
        .filter((charger) => charger.status === "Charging")
        .map((charger) => charger.allocatedPowerKw)
        .filter((power): power is number => power !== undefined);
    const allocatedPowerKw =
        reportedAllocations.length === chargingCount && chargingCount > 0
            ? reportedAllocations.reduce((total, power) => total + power, 0)
            : Math.min(siteCapacityKw, projectedDemandKw);
    const headroomKw = Math.max(0, siteCapacityKw - allocatedPowerKw);
    const capacityPercent = siteCapacityKw
        ? Math.min(100, (allocatedPowerKw / siteCapacityKw) * 100)
        : 0;
    const fairShareKw = chargingCount
        ? Math.min(CHARGER_MAX_POWER_KW, siteCapacityKw / chargingCount)
        : 0;
    return (
        <main className="shell">
            <header className="topbar">
                <div className="brand-mark" aria-label="VoltGrid">
                    <span className="brand-icon">V</span>
                    <span>VoltGrid</span>
                </div>
                <div className="topbar-meta">
                    <span className="station-chip">{site?.name ?? "SITE 01"}</span>
                    <span className={`service-pill ${backendOnline ? "online" : "offline"}`}>
                        <span className="status-dot" />
                        CSMS {backendOnline ? "online" : "offline"}
                    </span>
                    <span className="environment-label">DEMO CONTROL ROOM</span>
                </div>
            </header>

            <section className="hero hero-summary">
                <div className="hero-copy">
                    <p className="eyebrow">Operator console / browser simulation</p>
                    <h1>
                        Operate a charging site.
                        <span>No physical car required.</span>
                    </h1>
                    <p className="hero-text">
                        Add virtual chargers, run the OCPP session flow, and watch meter
                        readings and invoices update through the Hono CSMS.
                    </p>
                    <div className="hero-actions">
                        <a className="primary-button hero-button" href="#arrival">
                            Add a vehicle <span>+</span>
                        </a>
                        <span className="event-line">
                            <span className={`status-dot ${backendOnline ? "is-online" : ""}`} />
                            {demoStatus}
                        </span>
                    </div>
                </div>
            </section>

            <section className="readout-grid" aria-label="Simulation summary">
                <article className="readout-card featured-readout">
                    <div className="readout-icon capacity-icon">↯</div>
                    <div>
                        <span className="readout-label">Site capacity</span>
                        <strong>{formatPower(siteCapacityKw)}</strong>
                        <small>{site ? "Database-backed limit" : "CSMS configuration unavailable"}</small>
                    </div>
                </article>
                <article className="readout-card">
                    <div className="readout-icon draw-icon">≋</div>
                    <div>
                        <span className="readout-label">Active sessions</span>
                        <strong>{String(chargingCount).padStart(2, "0")}</strong>
                        <small>{formatPower(allocatedPowerKw)} projected allocation</small>
                    </div>
                </article>
                <article className="readout-card">
                    <div className="readout-icon headroom-icon">+</div>
                    <div>
                        <span className="readout-label">Available headroom</span>
                        <strong>{formatPower(headroomKw)}</strong>
                        <small>{chargers.length} simulated charger{chargers.length === 1 ? "" : "s"}</small>
                    </div>
                </article>
            </section>

            <section className="workspace-grid" id="arrival">
                <aside className="setup-panel panel">
                    <div className="panel-kicker">
                        <span>01</span>
                        <span>Arrival gate</span>
                    </div>
                    <div className="panel-heading">
                        <div>
                            <h2>New simulated vehicle</h2>
                            <p>Each vehicle gets its own browser WebSocket connection to the CSMS.</p>
                        </div>
                        <span className="panel-state">{chargers.length < 4 ? "Bay open" : "Station full"}</span>
                    </div>
                    <form onSubmit={addCharger} className="charger-form">
                        <label>
                            Charger ID
                            <input
                                value={chargerId}
                                onChange={(event) => setChargerId(event.target.value)}
                                placeholder="demo-car-001"
                            />
                        </label>
                        <label>
                            Driver ID tag
                            <input
                                value={idTag}
                                onChange={(event) => setIdTag(event.target.value)}
                                placeholder="DEMO-DRIVER-001"
                            />
                        </label>
                        <label>
                            Connector
                            <input
                                type="number"
                                min="1"
                                value={connectorId}
                                onChange={(event) => setConnectorId(event.target.value)}
                            />
                        </label>
                        <button type="submit" className="primary-button">
                            <span>+</span> Add vehicle
                        </button>
                    </form>
                    <div className="arrival-note">
                        <span className="note-line" />
                        <p>
                            <strong>Demo sequence</strong>
                            Connect → start → add energy → stop → invoice.
                        </p>
                    </div>

                    <form className="station-settings side-settings" onSubmit={saveSiteSettings}>
                        <div className="settings-header">
                            <span>Station settings</span>
                            <small>Saved to CSMS</small>
                        </div>
                        <div className="settings-fields">
                            <label>
                                Total capacity (kW)
                                <input
                                    type="number"
                                    step="any"
                                    value={powerLimitInput || String(siteCapacityKw)}
                                    onChange={(event) => setPowerLimitInput(event.target.value)}
                                />
                            </label>
                            <label>
                                Tariff (₹ / kWh)
                                <input
                                    type="number"
                                    step="any"
                                    value={tariffInput || (site ? String(site.tariffPaisePerKwh / 100) : "8")}
                                    onChange={(event) => setTariffInput(event.target.value)}
                                />
                            </label>
                            <button className="secondary-button" type="submit" disabled={savingSite || !backendOnline}>
                                {savingSite ? "Saving…" : "Save settings"}
                            </button>
                        </div>
                        {siteSaveMessage ? <p className="save-message">{siteSaveMessage}</p> : null}
                    </form>
                </aside>

                <section className="chargers-panel">
                    <div className="section-heading">
                        <div>
                            <p className="eyebrow">02 · Live fleet</p>
                            <h2>Charger simulator</h2>
                        </div>
                        <span className="live-label">
                            <span className="status-dot" />
                            {chargers.length} / 4 bays
                        </span>
                    </div>

                    {chargers.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">+</div>
                            <h3>No simulated chargers yet</h3>
                            <p>Add a vehicle on the left to begin the demo.</p>
                        </div>
                    ) : (
                        <div className="charger-grid">
                            {chargers.map((charger) => (
                                <article className="charger-card" key={charger.id}>
                                    <div className="card-header">
                                        <div>
                                            <div className="card-title-row">
                                                <span className={`charger-status-dot status-${charger.status.toLowerCase()}`} />
                                                <span className="card-status">{charger.status}</span>
                                            </div>
                                            <h3>{charger.id}</h3>
                                        </div>
                                        <button
                                            className="remove-button"
                                            onClick={() => removeCharger(charger.id)}
                                            aria-label={`Remove ${charger.id}`}
                                        >
                                            ×
                                        </button>
                                    </div>
                                    <div className="card-meta">
                                        <span>{charger.idTag}</span>
                                        <span>Connector {charger.connectorId}</span>
                                    </div>
                                    <div className="metric-row">
                                        <div className="metric-block">
                                            <span className="metric-label">Energy meter</span>
                                            <strong>{formatWh(charger.meterWh)}</strong>
                                        </div>
                                        <div className="metric-block align-right">
                                            <span className="metric-label">Transaction</span>
                                            <strong>{charger.transactionId ?? "—"}</strong>
                                        </div>
                                    </div>
                                    <div className="backend-line">
                                        <span>Projected draw</span>
                                        <strong>{charger.status === "Charging" ? formatPower(charger.allocatedPowerKw ?? fairShareKw) : "0 kW"}</strong>
                                    </div>
                                    {charger.invoice ? (
                                        <div className="invoice-strip">
                                            <div>
                                                <span className="metric-label">Latest invoice</span>
                                                <strong>₹{charger.invoice.amountInr}</strong>
                                            </div>
                                            <span>{charger.invoice.energyKwh.toFixed(2)} kWh × ₹{(charger.invoice.tariffPaisePerKwh / 100).toFixed(2)}/kWh</span>
                                        </div>
                                    ) : null}
                                    {charger.error ? <p className="error-message">{charger.error}</p> : null}
                                    <div className="card-actions">
                                        <button
                                            className="secondary-button"
                                            onClick={() => void connectCharger(charger.id).catch(() => undefined)}
                                            disabled={charger.status === "Connecting" || charger.status === "Charging" || charger.status === "Available"}
                                        >
                                            Connect
                                        </button>
                                        <button
                                            className="primary-button compact-button"
                                            onClick={() => void runDemo(charger.id)}
                                            disabled={charger.status === "Connecting" || charger.status === "Charging"}
                                        >
                                            Run full demo
                                        </button>
                                    </div>
                                    <div className="card-actions lower-actions">
                                        <button className="text-button" onClick={() => void startSession(charger.id)} disabled={charger.status !== "Available"}>Start</button>
                                        <button className="text-button" onClick={() => void addEnergy(charger.id)} disabled={charger.status !== "Charging"}>+1 kWh</button>
                                        <button className="text-button stop-button" onClick={() => void stopSession(charger.id)} disabled={charger.status !== "Charging"}>Stop & invoice</button>
                                        <button className="text-button" onClick={() => disconnectCharger(charger.id)} disabled={charger.status === "Offline"}>Disconnect</button>
                                    </div>
                                </article>
                            ))}
                        </div>
                    )}
                </section>
            </section>

            <footer className="footer-note">
                <span>VoltGrid / CSMS</span>
                <span>Browser-generated OCPP traffic · For demonstration only</span>
            </footer>
        </main>
    );
}
