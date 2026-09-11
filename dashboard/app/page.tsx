"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

const CSMS_HTTP_URL =
    process.env.NEXT_PUBLIC_CSMS_HTTP_URL ?? "http://localhost:6773";
const CSMS_WS_URL =
    process.env.NEXT_PUBLIC_CSMS_WS_URL ?? "ws://localhost:6773";

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
    error?: string;
};

type BackendConnector = {
    connectorId: number;
    status: string;
    errorCode: string;
};

type BackendCharger = {
    chargerId: string;
    connected: boolean;
    lastSeenAt: string;
    connectors: Record<string, BackendConnector>;
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

export default function Home() {
    const [chargers, setChargers] = useState<SimulatedCharger[]>([]);
    const [backendChargers, setBackendChargers] = useState<
        Map<string, BackendCharger>
    >(new Map());
    const [backendOnline, setBackendOnline] = useState(false);
    const [chargerId, setChargerId] = useState("sim-car-001");
    const [idTag, setIdTag] = useState("SIM-DRIVER-001");
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
                const response = await fetch(`${CSMS_HTTP_URL}/api/chargers`, {
                    cache: "no-store",
                });

                if (!response.ok) {
                    throw new Error("CSMS request failed");
                }

                const data = (await response.json()) as {
                    chargers?: BackendCharger[];
                };

                if (!cancelled) {
                    setBackendChargers(
                        new Map((data.chargers ?? []).map((charger) => [charger.chargerId, charger])),
                    );
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

        const [messageType, uniqueId, payload] = message;

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

        request.resolve(payload);
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
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                error: error instanceof Error ? error.message : String(error),
            });
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
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async function runDemo(id: string) {
        try {
            if (sockets.current.get(id)?.readyState !== WebSocket.OPEN) {
                await connectCharger(id);
            }

            await startSession(id);
            await new Promise((resolve) => setTimeout(resolve, 250));
            await addEnergy(id);
            await new Promise((resolve) => setTimeout(resolve, 250));
            await addEnergy(id);
            await stopSession(id);
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    function addCharger(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

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

        setChargers((current) => [
            ...current,
            {
                id,
                idTag: tag,
                connectorId: connector,
                status: "Offline",
                meterWh: 100_000,
            },
        ]);

        setChargerId(`sim-car-${chargersRef.current.length + 2}`);
        setIdTag(`SIM-DRIVER-${String(chargersRef.current.length + 2).padStart(3, "0")}`);
    }

    function disconnectCharger(id: string) {
        sockets.current.get(id)?.close();
        sockets.current.delete(id);
        updateCharger(id, { status: "Offline" });
    }

    function removeCharger(id: string) {
        disconnectCharger(id);
        setChargers((current) => current.filter((charger) => charger.id !== id));
    }

    const connectedCount = chargers.filter(
        (charger) => charger.status !== "Offline" && charger.status !== "Error",
    ).length;
    const chargingCount = chargers.filter(
        (charger) => charger.status === "Charging",
    ).length;

    return (
        <main className="shell">
            <header className="topbar">
                <div className="brand-mark" aria-label="VoltGrid">
                    <span className="brand-icon">V</span>
                    <span>VoltGrid</span>
                </div>
                <div className="topbar-meta">
                    <span className={`service-pill ${backendOnline ? "online" : "offline"}`}>
                        <span className="status-dot" />
                        CSMS {backendOnline ? "online" : "offline"}
                    </span>
                    <span className="environment-label">SIMULATION LAB</span>
                </div>
            </header>

            <section className="hero">
                <div className="hero-copy">
                    <p className="eyebrow">Operator control room · browser simulation</p>
                    <h1>Operate a charging site without a physical vehicle.</h1>
                    <p className="hero-text">
                        Add virtual chargers, run authentic OCPP-style messages through the
                        Hono CSMS, and watch sessions, meter readings, and invoices update
                        in real time.
                    </p>
                </div>
                <div className="hero-orbit" aria-hidden="true">
                    <div className="orbit-ring ring-one" />
                    <div className="orbit-ring ring-two" />
                    <div className="orbit-core">VG</div>
                </div>
            </section>

            <section className="summary-grid" aria-label="Simulation summary">
                <div className="summary-card">
                    <span className="summary-label">Simulated chargers</span>
                    <strong>{chargers.length.toString().padStart(2, "0")}</strong>
                    <span className="summary-detail">{connectedCount} connected</span>
                </div>
                <div className="summary-card accent-card">
                    <span className="summary-label">Active sessions</span>
                    <strong>{chargingCount.toString().padStart(2, "0")}</strong>
                    <span className="summary-detail">OCPP transactions</span>
                </div>
                <div className="summary-card">
                    <span className="summary-label">Site mode</span>
                    <strong>DEMO</strong>
                    <span className="summary-detail">No hardware required</span>
                </div>
            </section>

            <section className="workspace-grid">
                <aside className="setup-panel panel">
                    <div className="panel-heading">
                        <div>
                            <p className="eyebrow">01 · Add hardware</p>
                            <h2>New simulated charger</h2>
                        </div>
                        <span className="step-number">01</span>
                    </div>
                    <p className="panel-description">
                        Every card creates its own browser WebSocket connection to the
                        backend charger endpoint.
                    </p>
                    <form onSubmit={addCharger} className="charger-form">
                        <label>
                            Charger ID
                            <input
                                value={chargerId}
                                onChange={(event) => setChargerId(event.target.value)}
                                placeholder="sim-car-001"
                            />
                        </label>
                        <label>
                            Driver ID tag
                            <input
                                value={idTag}
                                onChange={(event) => setIdTag(event.target.value)}
                                placeholder="SIM-DRIVER-001"
                            />
                        </label>
                        <label>
                            Connector number
                            <input
                                type="number"
                                min="1"
                                value={connectorId}
                                onChange={(event) => setConnectorId(event.target.value)}
                            />
                        </label>
                        <button type="submit" className="primary-button">
                            <span>+</span> Add charger
                        </button>
                    </form>
                    <div className="workflow-note">
                        <span className="note-icon">i</span>
                        <p>
                            <strong>Demo workflow</strong>
                            Connect → start → add energy → stop → invoice.
                        </p>
                    </div>
                </aside>

                <section className="chargers-panel">
                    <div className="section-heading">
                        <div>
                            <p className="eyebrow">02 · Live fleet</p>
                            <h2>Charger simulator</h2>
                        </div>
                        <span className="live-label"><span className="status-dot" /> Polling backend</span>
                    </div>

                    {chargers.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">+</div>
                            <h3>No simulated chargers yet</h3>
                            <p>Add a charger on the left to begin the demo.</p>
                        </div>
                    ) : (
                        <div className="charger-grid">
                            {chargers.map((charger) => {
                                const backend = backendChargers.get(charger.id);
                                const backendConnector = backend?.connectors[String(charger.connectorId)];
                                const busy = charger.status === "Connecting";

                                return (
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

                                        <div className="meter-track">
                                            <span style={{ width: `${Math.min(100, Math.max(4, (charger.meterWh - 100_000) / 50))}%` }} />
                                        </div>

                                        <div className="backend-line">
                                            <span>Backend state</span>
                                            <strong>
                                                {backendConnector?.status ?? (backend?.connected ? "Connected" : "Not connected")}
                                            </strong>
                                        </div>

                                        {charger.invoice ? (
                                            <div className="invoice-strip">
                                                <div>
                                                    <span className="metric-label">Latest invoice</span>
                                                    <strong>₹{charger.invoice.amountInr}</strong>
                                                </div>
                                                <span>{charger.invoice.energyKwh.toFixed(2)} kWh · Issued</span>
                                            </div>
                                        ) : null}

                                        {charger.error ? <p className="error-message">{charger.error}</p> : null}

                                        <div className="card-actions">
                                            <button
                                                className="secondary-button"
                                                onClick={() => void connectCharger(charger.id).catch(() => undefined)}
                                                disabled={busy || charger.status === "Charging" || charger.status === "Available"}
                                            >
                                                Connect
                                            </button>
                                            <button
                                                className="primary-button compact-button"
                                                onClick={() => void runDemo(charger.id)}
                                                disabled={busy || charger.status === "Charging"}
                                            >
                                                Run full demo
                                            </button>
                                        </div>
                                        <div className="card-actions lower-actions">
                                            <button
                                                className="text-button"
                                                onClick={() => void startSession(charger.id)}
                                                disabled={charger.status !== "Available"}
                                            >
                                                Start
                                            </button>
                                            <button
                                                className="text-button"
                                                onClick={() => void addEnergy(charger.id)}
                                                disabled={charger.status !== "Charging"}
                                            >
                                                +1 kWh
                                            </button>
                                            <button
                                                className="text-button stop-button"
                                                onClick={() => void stopSession(charger.id)}
                                                disabled={charger.status !== "Charging"}
                                            >
                                                Stop & invoice
                                            </button>
                                            <button
                                                className="text-button"
                                                onClick={() => disconnectCharger(charger.id)}
                                                disabled={charger.status === "Offline"}
                                            >
                                                Disconnect
                                            </button>
                                        </div>
                                    </article>
                                );
                            })}
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
