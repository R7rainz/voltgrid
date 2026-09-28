"use client";

import {
    type CSSProperties,
    FormEvent,
    useEffect,
    useRef,
    useState,
} from "react";

import { allocateFirstComePower } from "./baseline-power";

const CSMS_HTTP_URL =
    process.env.NEXT_PUBLIC_CSMS_HTTP_URL ?? "http://localhost:6773";
const CSMS_WS_URL =
    process.env.NEXT_PUBLIC_CSMS_WS_URL ?? "ws://localhost:6773";
const DEFAULT_SITE_CAPACITY_KW = 100;
const DEFAULT_CAR_POWER_KW = 50;
const CAR_COLORS = ["#2f6fed", "#e45d3f", "#25866f", "#7657c8"];

type ChargerStatus =
    | "Offline"
    | "Connecting"
    | "Available"
    | "Preparing"
    | "Charging"
    | "Error";

type ProtocolStage =
    | "arrival"
    | "cable"
    | "websocket"
    | "boot"
    | "status"
    | "ready"
    | "authorize"
    | "meter"
    | "stop"
    | "invoice"
    | "complete"
    | "error";

const OCPP_JOURNEY = [
    ["Vehicle detected", "Driver and power request captured"],
    ["WebSocket", "Persistent charger link opened"],
    ["BootNotification", "Charger identity registered"],
    ["StatusNotification", "Connector availability reported"],
    ["StartTransaction", "Driver tag authorised"],
    ["MeterValues", "Energy readings persisted"],
    ["StopTransaction", "Session closed and invoiced"],
] as const;

const PROTOCOL_PROGRESS: Record<
    ProtocolStage,
    { active: number | null; doneThrough: number }
> = {
    arrival: { active: 0, doneThrough: -1 },
    cable: { active: 0, doneThrough: -1 },
    websocket: { active: 1, doneThrough: 0 },
    boot: { active: 2, doneThrough: 1 },
    status: { active: 3, doneThrough: 2 },
    ready: { active: null, doneThrough: 3 },
    authorize: { active: 4, doneThrough: 3 },
    meter: { active: 5, doneThrough: 4 },
    stop: { active: 6, doneThrough: 5 },
    invoice: { active: 6, doneThrough: 5 },
    complete: { active: null, doneThrough: 6 },
    error: { active: null, doneThrough: -1 },
};

const CHARGER_SCREEN: Record<ProtocolStage, string> = {
    arrival: "WAIT",
    cable: "PLUG",
    websocket: "LINK",
    boot: "BOOT",
    status: "SYNC",
    ready: "READY",
    authorize: "AUTH",
    meter: "CHARGE",
    stop: "STOP",
    invoice: "BILL",
    complete: "DONE",
    error: "ERROR",
};

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
    requestedPowerKw: number;
    protocolStage: ProtocolStage;
    status: ChargerStatus;
    meterWh: number;
    arriving: boolean;
    transactionId?: number;
    sessionStartWh?: number;
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

function protocolMessage(stage: ProtocolStage) {
    const step = OCPP_JOURNEY[PROTOCOL_PROGRESS[stage].active ?? 1];
    return `${step[0]} · ${step[1]}`;
}

const wait = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

function getProfileLimitKw(payload: unknown) {
    if (!isObject(payload) || !isObject(payload.csChargingProfiles)) {
        return 0;
    }

    const schedule = payload.csChargingProfiles.chargingSchedule;

    if (!isObject(schedule) || !Array.isArray(schedule.chargingSchedulePeriod)) {
        return 0;
    }

    const firstPeriod = schedule.chargingSchedulePeriod[0];

    return isObject(firstPeriod) && typeof firstPeriod.limit === "number"
        ? Math.max(0, firstPeriod.limit / 1000)
        : 0;
}

function CarVisual({ color }: { color: string }) {
    return (
        <svg
            className="car-visual"
            viewBox="0 0 84 150"
            role="img"
            aria-label="Electric vehicle"
        >
            <ellipse cx="42" cy="140" rx="31" ry="7" fill="rgba(24, 35, 29, 0.2)" />
            <rect x="3" y="34" width="8" height="29" rx="4" fill="#1f2729" />
            <rect x="73" y="34" width="8" height="29" rx="4" fill="#1f2729" />
            <rect x="3" y="91" width="8" height="29" rx="4" fill="#1f2729" />
            <rect x="73" y="91" width="8" height="29" rx="4" fill="#1f2729" />
            <path
                d="M25 4h34c8 0 14 7 16 17l5 101c1 13-8 23-20 23H24c-12 0-21-10-20-23L9 21C11 11 17 4 25 4Z"
                fill={color}
                stroke="rgba(20, 30, 28, 0.3)"
                strokeWidth="2"
            />
            <path d="M20 34c2-12 7-19 14-21h16c7 2 12 9 14 21l2 17H18l2-17Z" fill="#bfd7df" />
            <path d="M19 92h46l-3 28c-1 7-6 11-12 12H34c-6-1-11-5-12-12l-3-28Z" fill="#9bb8c1" />
            <rect x="19" y="56" width="46" height="31" rx="9" fill={color} opacity="0.84" />
            <path d="M14 58h5v24h-7c-3 0-5-2-5-5V64c0-3 3-6 7-6Z" fill={color} />
            <path d="M70 58h-5v24h7c3 0 5-2 5-5V64c0-3-3-6-7-6Z" fill={color} />
            <rect x="15" y="16" width="12" height="5" rx="2.5" fill="#f8f4c8" />
            <rect x="57" y="16" width="12" height="5" rx="2.5" fill="#f8f4c8" />
            <rect x="15" y="126" width="12" height="5" rx="2.5" fill="#e95f58" />
            <rect x="57" y="126" width="12" height="5" rx="2.5" fill="#e95f58" />
            <circle cx="42" cy="73" r="7" fill="rgba(255, 255, 255, 0.2)" />
            <path d="m38 64 10 8-7 2 4 8-11-10 7-2-3-6Z" fill="white" />
        </svg>
    );
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
    const [requestedPowerInput, setRequestedPowerInput] = useState(
        String(DEFAULT_CAR_POWER_KW),
    );
    const [focusedChargerId, setFocusedChargerId] = useState<string>();
    const sockets = useRef(new Map<string, WebSocket>());
    const pending = useRef(new Map<string, PendingRequest>());
    const arrivalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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

            for (const timer of arrivalTimers.current.values()) {
                clearTimeout(timer);
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

    function showStation(id: string) {
        setFocusedChargerId(id);
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

        const [messageType, uniqueId, actionOrPayload] = message;

        if (
            messageType === 2 &&
            typeof uniqueId === "string" &&
            typeof actionOrPayload === "string"
        ) {
            const socket = sockets.current.get(id);

            if (!socket || socket.readyState !== WebSocket.OPEN) {
                return;
            }

            if (actionOrPayload === "SetChargingProfile") {
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
                    `${actionOrPayload} is not supported by the browser simulator`,
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

        request.resolve(actionOrPayload);
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
        updateCharger(id, {
            status: "Connecting",
            protocolStage: "websocket",
            error: undefined,
        });

        const socket = new WebSocket(
            `${CSMS_WS_URL}/ocpp/${encodeURIComponent(charger.id)}`,
        );
        sockets.current.set(id, socket);

        socket.onmessage = (event) => handleMessage(id, event);

        return new Promise<void>((resolve, reject) => {
            let settled = false;

            const fail = (error: Error) => {
                updateCharger(id, {
                    status: "Error",
                    protocolStage: "error",
                    error: error.message,
                });

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
                    setDemoStatus(`${id} WebSocket connected · persistent OCPP link ready`);
                    await wait(650);

                    updateCharger(id, { protocolStage: "boot" });
                    setDemoStatus(`${id} → BootNotification · identifying charger`);
                    await wait(650);

                    const bootResponse = await sendCall(id, "BootNotification", {
                        chargePointVendor: "VoltGrid Simulator",
                        chargePointModel: "Browser Charger",
                    });

                    if (!isObject(bootResponse) || bootResponse.status !== "Accepted") {
                        throw new Error("BootNotification was rejected");
                    }

                    updateCharger(id, { protocolStage: "status" });
                    setDemoStatus(`${id} → StatusNotification · reporting connector`);
                    await wait(650);

                    await sendCall(id, "StatusNotification", {
                        connectorId: charger.connectorId,
                        status: "Available",
                        errorCode: "NoError",
                    });

                    updateCharger(id, {
                        status: "Available",
                        protocolStage: "ready",
                    });
                    setDemoStatus(`${id} registered · connector available in CSMS`);

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
            setDemoStatus(`${id} → StatusNotification · vehicle preparing`);
            updateCharger(id, {
                status: "Preparing",
                protocolStage: "authorize",
                error: undefined,
            });

            await sendCall(id, "StatusNotification", {
                connectorId: charger.connectorId,
                status: "Preparing",
                errorCode: "NoError",
            });

            setDemoStatus(`${id} → StartTransaction · authorising ${charger.idTag}`);
            await wait(750);

            const response = await sendCall(id, "StartTransaction", {
                connectorId: charger.connectorId,
                idTag: charger.idTag,
                meterStart: charger.meterWh,
                timestamp: new Date().toISOString(),
            });

            const transactionStatus =
                isObject(response) && isObject(response.idTagInfo)
                    ? response.idTagInfo.status
                    : undefined;

            if (
                !isObject(response) ||
                (transactionStatus !== "Accepted" &&
                    transactionStatus !== "ConcurrentTx") ||
                typeof response.transactionId !== "number"
            ) {
                throw new Error("StartTransaction was rejected");
            }

            const meterWh =
                transactionStatus === "ConcurrentTx" &&
                typeof response.meterWh === "number"
                    ? Math.max(charger.meterWh, response.meterWh)
                    : charger.meterWh;

            await sendCall(id, "StatusNotification", {
                connectorId: charger.connectorId,
                status: "Charging",
                errorCode: "NoError",
            });

            updateCharger(id, {
                status: "Charging",
                protocolStage: "meter",
                transactionId: response.transactionId,
                meterWh,
                sessionStartWh: meterWh,
                invoice: undefined,
            });
            setDemoStatus(
                transactionStatus === "ConcurrentTx"
                    ? `${id} resumed · active transaction recovered`
                    : `${id} charging · unmanaged ${formatPower(charger.requestedPowerKw)} request accepted`,
            );
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                protocolStage: "error",
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

        const suppliedPowerKw =
            allocateFirstComePower(
                chargersRef.current,
                site?.powerLimitKw ?? DEFAULT_SITE_CAPACITY_KW,
            ).get(id) ?? 0;

        if (suppliedPowerKw === 0) {
            setDemoStatus(`${id} waiting · no site power remains`);
            return;
        }

        const addedWh = Math.max(
            1,
            Math.round((1000 * suppliedPowerKw) / charger.requestedPowerKw),
        );
        const meterWh = charger.meterWh + addedWh;

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
            setDemoStatus(
                `${id} receiving ${formatPower(suppliedPowerKw)} · +${(
                    addedWh / 1000
                ).toFixed(1)} kWh recorded`,
            );
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                protocolStage: "error",
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
            updateCharger(id, { protocolStage: "stop" });
            await wait(650);
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

            updateCharger(id, { protocolStage: "invoice" });
            setDemoStatus(`${id} session accepted · generating invoice`);

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

            updateCharger(id, {
                status: "Available",
                protocolStage: "complete",
                invoice: invoiceData.invoice,
            });
            setDemoStatus(`${id} complete · invoice issued`);
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                protocolStage: "error",
                error: error instanceof Error ? error.message : String(error),
            });
            setDemoStatus(`${id} session failed to close`);
        }
    }

    async function runDemo(id: string) {
        try {
            showStation(id);
            setDemoStatus(`Vehicle arrival sequence · ${id}`);

            if (sockets.current.get(id)?.readyState !== WebSocket.OPEN) {
                await connectCharger(id);
            }

            await startSession(id);

            if (chargersRef.current.find((charger) => charger.id === id)?.status !== "Charging") {
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, 1_200));

            for (let reading = 0; reading < 4; reading += 1) {
                await addEnergy(id);
                await new Promise((resolve) => setTimeout(resolve, 1_200));
            }

            await new Promise((resolve) => setTimeout(resolve, 800));
            await stopSession(id);
        } catch (error) {
            updateCharger(id, {
                status: "Error",
                protocolStage: "error",
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
        const requestedPowerKw = Number(requestedPowerInput);

        if (
            !id ||
            !tag ||
            !Number.isInteger(connector) ||
            connector < 1 ||
            !Number.isFinite(requestedPowerKw) ||
            requestedPowerKw < 0 ||
            chargersRef.current.some((charger) => charger.id === id)
        ) {
            return;
        }

        const nextCharger: SimulatedCharger = {
            id,
            idTag: tag,
            connectorId: connector,
            requestedPowerKw,
            protocolStage: "arrival",
            status: "Offline",
            meterWh: 100_000,
            arriving: true,
        };
        const nextChargers = [...chargersRef.current, nextCharger];

        chargersRef.current = nextChargers;
        setChargers(nextChargers);
        setFocusedChargerId(id);
        setDemoStatus(`${id} approaching · assigning bay ${nextChargers.length}`);

        const timer = setTimeout(async () => {
            arrivalTimers.current.delete(id);
            updateCharger(id, {
                arriving: false,
                status: "Connecting",
                protocolStage: "cable",
            });
            setDemoStatus(`${id} parked · connecting charger cable`);
            await wait(900);
            void connectCharger(id).catch(() => undefined);
        }, 4800);
        arrivalTimers.current.set(id, timer);

        setChargerId(`demo-car-${String(nextChargers.length + 1).padStart(3, "0")}`);
        setIdTag(`DEMO-DRIVER-${String(nextChargers.length + 1).padStart(3, "0")}`);
    }

    function disconnectCharger(id: string) {
        const timer = arrivalTimers.current.get(id);

        if (timer) {
            clearTimeout(timer);
            arrivalTimers.current.delete(id);
        }

        sockets.current.get(id)?.close();
        sockets.current.delete(id);
        updateCharger(id, { status: "Offline", protocolStage: "websocket" });
        setDemoStatus(`${id} disconnected · site capacity released`);
    }

    function removeCharger(id: string) {
        disconnectCharger(id);
        const nextChargers = chargersRef.current.filter((charger) => charger.id !== id);
        chargersRef.current = nextChargers;
        setChargers(nextChargers);
        setFocusedChargerId((current) =>
            current === id ? nextChargers.at(-1)?.id : current,
        );
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
    const parkedChargers = chargers.filter((charger) => !charger.arriving);
    const projectedDemandKw = chargers
        .filter((charger) => charger.status === "Charging")
        .reduce((total, charger) => total + charger.requestedPowerKw, 0);
    const baselinePowerById = allocateFirstComePower(
        chargers,
        siteCapacityKw,
    );
    const suppliedPowerKw = [...baselinePowerById.values()].reduce(
        (total, power) => total + power,
        0,
    );
    const unmetDemandKw = Math.max(0, projectedDemandKw - suppliedPowerKw);
    const focusedCharger =
        chargers.find((charger) => charger.id === focusedChargerId) ??
        chargers.at(-1);
    const focusedProtocol = focusedCharger
        ? PROTOCOL_PROGRESS[focusedCharger.protocolStage]
        : undefined;
    return (
        <main className="shell">
            <header className="topbar">
                <div className="brand-mark" aria-label="VoltGrid">
                    <img className="brand-icon" src="/icon.svg" alt="" />
                    <span>VoltGrid</span>
                </div>
                <div className="topbar-meta">
                    <span className="station-chip">{site?.name ?? "SITE 01"}</span>
                    <span className={`service-pill ${backendOnline ? "online" : "offline"}`}>
                        <span className="status-dot" />
                        CSMS {backendOnline ? "online" : "offline"}
                    </span>
                    <span className="environment-label">LIVE STATION DEMO</span>
                </div>
            </header>

            <section className="station-experience">
                <div className="station-floor" aria-label="VoltGrid charging station">
                    <div className="station-landscape" aria-hidden="true">
                        <span className="distant-building building-one" />
                        <span className="distant-building building-two" />
                        <span className="station-tree tree-one" />
                        <span className="station-tree tree-two" />
                    </div>

                    <div className="roadside-sign">
                        <img className="sign-mark" src="/icon.svg" alt="" />
                        <div>
                            <strong>{site?.name ?? "VoltGrid Central"}</strong>
                            <small>EV charging · Open 24 hours</small>
                        </div>
                    </div>

                    <div className="solar-canopy" aria-hidden="true">
                        <div className="solar-panels">
                            <i />
                            <i />
                            <i />
                            <i />
                        </div>
                        <span className="canopy-brand">VOLTGRID</span>
                    </div>

                    <div className="parking-area">
                        <div className="station-bays">
                            {[0, 1, 2, 3].map((bayIndex) => {
                                const charger = chargers[bayIndex];
                                const isConnected =
                                    charger &&
                                    !charger.arriving &&
                                    charger.status !== "Offline" &&
                                    charger.status !== "Error";

                                return (
                                    <article
                                        className={`station-bay ${charger ? "is-occupied" : ""}`}
                                        key={bayIndex}
                                    >
                                        <span className="bay-number">{bayIndex + 1}</span>
                                        <div
                                            className={`charger-pedestal ${isConnected ? "is-online" : ""}`}
                                            aria-hidden="true"
                                        >
                                            <span className="charger-screen">
                                                {charger
                                                    ? CHARGER_SCREEN[charger.protocolStage]
                                                    : "IDLE"}
                                            </span>
                                            <span className="charger-port" />
                                        </div>
                                        <span
                                            className={`charger-cable ${isConnected ? "is-connected" : ""}`}
                                            aria-hidden="true"
                                        />

                                        {charger && !charger.arriving ? (
                                            <div
                                                className={`scene-vehicle status-${charger.status.toLowerCase()}`}
                                            >
                                                <CarVisual color={CAR_COLORS[bayIndex]} />
                                                <strong>{charger.id}</strong>
                                                <small>{charger.status}</small>
                                            </div>
                                        ) : !charger ? (
                                            <div className="empty-bay">
                                                <span>EV</span>
                                                <small>Available</small>
                                            </div>
                                        ) : null}
                                    </article>
                                );
                            })}
                        </div>
                    </div>

                    <div className="station-road">
                        <span className="road-edge top" />
                        <span className="road-mark mark-one" />
                        <span className="road-mark mark-two" />
                        <span className="road-mark mark-three" />
                        <span className="road-arrow">→</span>
                        <small>Station entrance</small>
                    </div>

                    {chargers.map((charger, bayIndex) =>
                        charger.arriving ? (
                            <div
                                className="arrival-car"
                                key={charger.id}
                                style={
                                    {
                                        "--target-left": `${12.5 + bayIndex * 25}%`,
                                    } as CSSProperties
                                }
                            >
                                <CarVisual color={CAR_COLORS[bayIndex]} />
                                <span>Arriving</span>
                            </div>
                        ) : null,
                    )}

                    {chargers.map((focusedCharger, focusedChargerIndex) => {
                        if (focusedCharger.arriving) {
                            return null;
                        }

                        const focusedSessionEnergyKwh = Math.max(
                            0,
                            (focusedCharger.meterWh -
                                (focusedCharger.sessionStartWh ?? focusedCharger.meterWh)) /
                                1000,
                        );
                        const focusedSessionCostInr =
                            focusedSessionEnergyKwh *
                            ((site?.tariffPaisePerKwh ?? 800) / 100);
                        const focusedPowerKw =
                            baselinePowerById.get(focusedCharger.id) ?? 0;

                        return (
                        <aside
                            className={`vehicle-stage-card stage-${focusedCharger.status.toLowerCase()} ${
                                focusedCharger.id === focusedChargerId ? "is-focused" : ""
                            }`}
                            key={focusedCharger.id}
                            style={
                                {
                                    "--stage-left": `${12.5 + focusedChargerIndex * 25}%`,
                                } as CSSProperties
                            }
                            aria-live="polite"
                            onClick={() => showStation(focusedCharger.id)}
                        >
                            {focusedCharger.status === "Charging" ? (
                                <>
                                    <div className="stage-card-heading">
                                        <span className="charging-indicator" />
                                        <div>
                                            <small>Live charging</small>
                                            <strong>{focusedCharger.id}</strong>
                                        </div>
                                    </div>
                                    <div className="charging-progress">
                                        <span
                                            style={{
                                                width: `${Math.min(100, focusedSessionEnergyKwh * 25)}%`,
                                            }}
                                        />
                                    </div>
                                    <div className="stage-stats">
                                        <div>
                                            <small>Energy added</small>
                                            <strong>{focusedSessionEnergyKwh.toFixed(1)} kWh</strong>
                                        </div>
                                        <div>
                                            <small>Power received</small>
                                            <strong
                                                className={
                                                    focusedPowerKw < focusedCharger.requestedPowerKw
                                                        ? "power-shortfall"
                                                        : undefined
                                                }
                                            >
                                                {formatPower(focusedPowerKw)} / {formatPower(focusedCharger.requestedPowerKw)}
                                            </strong>
                                        </div>
                                        <div>
                                            <small>Live cost</small>
                                            <strong>₹{focusedSessionCostInr.toFixed(2)}</strong>
                                        </div>
                                    </div>
                                </>
                            ) : focusedCharger.invoice ? (
                                <>
                                    <div className="stage-card-heading complete-heading">
                                        <span className="complete-mark">✓</span>
                                        <div>
                                            <small>Charging complete</small>
                                            <strong>Invoice ₹{focusedCharger.invoice.amountInr}</strong>
                                        </div>
                                    </div>
                                    <div className="stage-summary">
                                        <span>{focusedCharger.invoice.energyKwh.toFixed(2)} kWh delivered</span>
                                        <span>Transaction {focusedCharger.transactionId}</span>
                                    </div>
                                    <button
                                        className="stage-action"
                                        onClick={() => void runDemo(focusedCharger.id)}
                                    >
                                        Run another session
                                    </button>
                                </>
                            ) : focusedCharger.status === "Available" ? (
                                <>
                                    <div className="stage-card-heading">
                                        <span className="ready-mark">↯</span>
                                        <div>
                                            <small>Connected and ready</small>
                                            <strong>{focusedCharger.id}</strong>
                                        </div>
                                    </div>
                                    <div className="stage-summary">
                                        <span>{focusedCharger.idTag}</span>
                                        <span>Connector {focusedCharger.connectorId}</span>
                                        <span>Needs {formatPower(focusedCharger.requestedPowerKw)}</span>
                                    </div>
                                    <button
                                        className="stage-action"
                                        onClick={() => void runDemo(focusedCharger.id)}
                                    >
                                        Run full charging demo
                                    </button>
                                </>
                            ) : (
                                <>
                                    <div className="stage-card-heading">
                                        <span className="stage-spinner" />
                                        <div>
                                            <small>
                                                {focusedCharger.status === "Error"
                                                    ? "Connection problem"
                                                    : "Preparing charger"}
                                            </small>
                                            <strong>{focusedCharger.id}</strong>
                                        </div>
                                    </div>
                                    <p className="stage-message">
                                        {focusedCharger.error ??
                                            protocolMessage(
                                                focusedCharger.protocolStage,
                                            )}
                                    </p>
                                    {focusedCharger.status === "Error" ||
                                    focusedCharger.status === "Offline" ? (
                                        <button
                                            className="stage-action"
                                            onClick={() => void runDemo(focusedCharger.id)}
                                        >
                                            Retry connection
                                        </button>
                                    ) : null}
                                </>
                            )}
                        </aside>
                        );
                    })}

                    {unmetDemandKw > 0 ? (
                        <div className="power-warning" role="status">
                            <strong>Load balancing problem</strong>
                            <span>
                                {formatPower(projectedDemandKw)} requested exceeds the {formatPower(siteCapacityKw)} site limit. {formatPower(unmetDemandKw)} of demand is unmet.
                            </span>
                        </div>
                    ) : null}

                    <div className="station-event">
                        <span className={`status-dot ${backendOnline ? "is-online" : ""}`} />
                        <strong>{demoStatus}</strong>
                    </div>

                    <div className="station-floor-footer">
                        <span>{chargers.length} of 4 bays occupied</span>
                        <span>
                            Site limit {formatPower(siteCapacityKw)} · Demand {formatPower(projectedDemandKw)} · Supplied {formatPower(suppliedPowerKw)}
                            {unmetDemandKw > 0 ? ` · Unmet ${formatPower(unmetDemandKw)}` : ""}
                        </span>
                    </div>
                </div>
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
                        <label>
                            Max power request (kW)
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={requestedPowerInput}
                                onChange={(event) =>
                                    setRequestedPowerInput(event.target.value)
                                }
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
                            {parkedChargers.length} parked vehicle{parkedChargers.length === 1 ? "" : "s"}
                        </span>
                    </div>

                    {focusedCharger && focusedProtocol ? (
                        <aside className="protocol-monitor" aria-live="polite">
                            <div className="protocol-monitor-header">
                                <div>
                                    <small>Live backend flow</small>
                                    <strong>{focusedCharger.id}</strong>
                                </div>
                                <span>{CHARGER_SCREEN[focusedCharger.protocolStage]}</span>
                            </div>
                            <div className="vehicle-handshake">
                                <span>
                                    <small>Driver tag</small>
                                    <strong>{focusedCharger.idTag}</strong>
                                </span>
                                <span>
                                    <small>Connector</small>
                                    <strong>{focusedCharger.connectorId}</strong>
                                </span>
                                <span>
                                    <small>Power need</small>
                                    <strong>{formatPower(focusedCharger.requestedPowerKw)}</strong>
                                </span>
                            </div>
                            <ol className="protocol-steps">
                                {OCPP_JOURNEY.map(([action, detail], index) => {
                                    const done = index <= focusedProtocol.doneThrough;
                                    const active = index === focusedProtocol.active;

                                    return (
                                        <li
                                            className={`${done ? "is-done" : ""} ${
                                                active ? "is-active" : ""
                                            }`}
                                            key={action}
                                        >
                                            <i>{done ? "✓" : index + 1}</i>
                                            <span>
                                                <strong>{action}</strong>
                                                <small>{detail}</small>
                                            </span>
                                            {active ? <em>LIVE</em> : null}
                                        </li>
                                    );
                                })}
                            </ol>
                        </aside>
                    ) : null}

                    {parkedChargers.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">+</div>
                            <h3>{chargers.length ? "Vehicle approaching" : "No vehicles on site"}</h3>
                            <p>
                                {chargers.length
                                    ? "The session card will appear when the EV reaches its bay."
                                    : "Add a vehicle on the left to begin the station simulation."}
                            </p>
                        </div>
                    ) : (
                        <div className="charger-grid">
                            {parkedChargers.map((charger) => (
                                <article
                                    className={`charger-card ${
                                        focusedCharger?.id === charger.id ? "is-focused" : ""
                                    }`}
                                    key={charger.id}
                                    onClick={() => showStation(charger.id)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            showStation(charger.id);
                                        }
                                    }}
                                    role="button"
                                    tabIndex={0}
                                >
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
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                removeCharger(charger.id);
                                            }}
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
                                        <span>Allocated power</span>
                                        <strong>
                                            {charger.status === "Charging"
                                                ? formatPower(
                                                      baselinePowerById.get(charger.id) ?? 0,
                                                  )
                                                : "0 kW"}
                                        </strong>
                                    </div>
                                    <div className="tariff-strip">
                                        <span>Station tariff</span>
                                        <strong>
                                            ₹{((site?.tariffPaisePerKwh ?? 800) / 100).toFixed(2)}
                                            <small> / kWh</small>
                                        </strong>
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

        </main>
    );
}
