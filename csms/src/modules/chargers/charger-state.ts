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
    allocatedPowerKw: number;
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
            allocatedPowerKw: 0,
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
    charger.allocatedPowerKw = 0;

    return charger;
}

export function updateChargerAllocation(
    chargerId: string,
    allocatedPowerKw: number,
) {
    const charger = getOrCreateCharger(chargerId);

    charger.allocatedPowerKw = allocatedPowerKw;
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
