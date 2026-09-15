export type ChargerSocket = {
    send(message: string): void;
};

type PendingCall = {
    chargerId: string;
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

const sockets = new Map<string, ChargerSocket>();
const pendingCalls = new Map<string, PendingCall>();
let requestNumber = 0;

export function registerChargerSocket(
    chargerId: string,
    socket: ChargerSocket,
) {
    sockets.set(chargerId, socket);
}

export function unregisterChargerSocket(chargerId: string) {
    sockets.delete(chargerId);

    for (const [uniqueId, pendingCall] of pendingCalls) {
        if (pendingCall.chargerId !== chargerId) {
            continue;
        }

        clearTimeout(pendingCall.timeout);
        pendingCall.reject(new Error("Charger disconnected"));
        pendingCalls.delete(uniqueId);
    }
}

export function sendChargerCall(
    chargerId: string,
    action: string,
    payload: Record<string, unknown>,
) {
    const socket = sockets.get(chargerId);

    if (!socket) {
        return Promise.reject(new Error(`Charger ${chargerId} is not connected`));
    }

    const uniqueId = `csms-${++requestNumber}`;

    return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCalls.delete(uniqueId);
            reject(new Error(`Timed out waiting for ${action} from ${chargerId}`));
        }, 5_000);

        pendingCalls.set(uniqueId, {
            chargerId,
            resolve,
            reject,
            timeout,
        });

        try {
            socket.send(JSON.stringify([2, uniqueId, action, payload]));
        } catch (error) {
            clearTimeout(timeout);
            pendingCalls.delete(uniqueId);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export function resolveChargerCall(
    chargerId: string,
    message: unknown[],
) {
    const messageType = message[0];
    const uniqueId = message[1];

    if (
        (messageType !== 3 && messageType !== 4) ||
        typeof uniqueId !== "string"
    ) {
        return false;
    }

    const pendingCall = pendingCalls.get(uniqueId);

    if (
        !pendingCall ||
        pendingCall.chargerId !== chargerId
    ) {
        return false;
    }

    clearTimeout(pendingCall.timeout);
    pendingCalls.delete(uniqueId);

    if (messageType === 4) {
        pendingCall.reject(
            new Error(`${String(message[2])}: ${String(message[3] ?? "unknown error")}`),
        );
    } else {
        pendingCall.resolve(message[2]);
    }

    return true;
}
