const port = Number(Bun.env.PORT ?? 6773);
const chargerId = Bun.env.CHARGER_ID ?? "sim-charger-001";
const connectorId = Number(Bun.env.CONNECTOR_ID ?? 1);
const idTag = Bun.env.ID_TAG ?? "SIM-DRIVER-001";
const responseTimeoutMs = 30_000;
const apiUrl = `http://localhost:${port}`;

if (!Number.isInteger(connectorId) || connectorId < 1) {
    throw new Error("CONNECTOR_ID must be a positive integer");
}

type PendingRequest = {
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

const socket = new WebSocket(
    `ws://localhost:${port}/ocpp/${encodeURIComponent(chargerId)}`,
);
const pending = new Map<string, PendingRequest>();
let requestNumber = 0;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failPending(error: Error) {
    for (const [uniqueId, request] of pending) {
        clearTimeout(request.timeout);
        request.reject(error);
        pending.delete(uniqueId);
    }
}

function call(action: string, payload: Record<string, unknown>) {
    const uniqueId = `sim-${++requestNumber}`;

    return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(uniqueId);
            reject(new Error(`Timed out waiting for ${action}`));
        }, responseTimeoutMs);

        pending.set(uniqueId, { resolve, reject, timeout });
        socket.send(JSON.stringify([2, uniqueId, action, payload]));
    });
}

socket.onmessage = (event) => {
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

    const request = pending.get(uniqueId);

    if (!request) {
        return;
    }

    clearTimeout(request.timeout);
    pending.delete(uniqueId);

    if (messageType === 4) {
        request.reject(new Error(`${message[2]}: ${message[3] ?? "unknown error"}`));
        return;
    }

    request.resolve(payload);
};

socket.onerror = () => {
    failPending(new Error("Charger simulator WebSocket error"));
};

socket.onclose = () => {
    failPending(new Error("CSMS closed the simulator connection"));
};

async function runSimulation() {
    console.log(`Simulating charger ${chargerId} on connector ${connectorId}`);

    const bootResponse = await call("BootNotification", {
        chargePointVendor: "VoltGrid Simulator",
        chargePointModel: "Demo Charger",
    });

    if (!isObject(bootResponse) || bootResponse.status !== "Accepted") {
        throw new Error(`BootNotification was rejected: ${JSON.stringify(bootResponse)}`);
    }

    await call("StatusNotification", {
        connectorId,
        status: "Available",
        errorCode: "NoError",
    });

    await call("StatusNotification", {
        connectorId,
        status: "Preparing",
        errorCode: "NoError",
    });

    const meterStart = 100_000;
    const startResponse = await call("StartTransaction", {
        connectorId,
        idTag,
        meterStart,
        timestamp: new Date().toISOString(),
    });

    if (
        !isObject(startResponse) ||
        typeof startResponse.transactionId !== "number" ||
        !isObject(startResponse.idTagInfo) ||
        startResponse.idTagInfo.status !== "Accepted"
    ) {
        throw new Error(`StartTransaction failed: ${JSON.stringify(startResponse)}`);
    }

    const transactionId = startResponse.transactionId;

    await call("StatusNotification", {
        connectorId,
        status: "Charging",
        errorCode: "NoError",
    });

    for (const meterWh of [101_000, 102_500]) {
        await call("MeterValues", {
            connectorId,
            transactionId,
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
    }

    const stopResponse = await call("StopTransaction", {
        transactionId,
        meterStop: 102_500,
        timestamp: new Date().toISOString(),
        reason: "Local",
    });

    if (
        !isObject(stopResponse) ||
        !isObject(stopResponse.idTagInfo) ||
        stopResponse.idTagInfo.status !== "Accepted"
    ) {
        throw new Error(`StopTransaction failed: ${JSON.stringify(stopResponse)}`);
    }

    await call("StatusNotification", {
        connectorId,
        status: "Available",
        errorCode: "NoError",
    });

    const invoiceResponse = await fetch(
        `${apiUrl}/api/sessions/${transactionId}/invoice`,
    );

    console.log(`Transaction ${transactionId} completed`);
    console.log(`Invoice response: ${await invoiceResponse.text()}`);

    socket.close();
}

socket.onopen = () => {
    console.log(`Connected to CSMS at ws://localhost:${port}/ocpp/${chargerId}`);
    runSimulation().catch((error) => {
        console.error("Charger simulation failed:", error);
        socket.close();
    });
};
