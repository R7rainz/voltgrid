export type ConnectorState = {
    connectorId: number;
    status: string;
    errorCode: string;
    updatedAt: string;
};

export type ChargerState = {
    chargerId: string;
    connected: boolean;
    lastSeenAt: string;
    connectors: Record<string, ConnectorState>;
};

const chargers = new Map<string, ChargerState>();

function now() {
    return new Date().toISOString();
}

export function getOrCreateCharger(chargerId: string) {
    let charger = chargers.get(chargerId);

    if (!charger) {
        charger = {
            chargerId,
            connected: false,
            lastSeenAt: now(),
            connectors: {},
        };

        chargers.set(chargerId, charger);
    }

    return charger;
}

export function markChargerConnected(chargerId: string) {
    const charger = getOrCreateCharger(chargerId);

    charger.connected = true;
    charger.lastSeenAt = now();

    return charger;
}

export function markChargerSeen(chargerId: string) {
    const charger = getOrCreateCharger(chargerId);

    charger.lastSeenAt = now();

    return charger;
}

export function markChargerDisconnected(chargerId: string) {
    const charger = getOrCreateCharger(chargerId);

    charger.connected = false;
    charger.lastSeenAt = now();

    return charger;
}

export function updateConnectorStatus(
    chargerId: string,
    connectorId: number,
    status: string,
    errorCode: string,
) {
    const charger = getOrCreateCharger(chargerId);

    charger.connectors[String(connectorId)] = {
        connectorId,
        status,
        errorCode,
        updatedAt: now(),
    };

    charger.lastSeenAt = now();

    return charger;
}

export function getAllChargers() {
    return Array.from(chargers.values());
}
