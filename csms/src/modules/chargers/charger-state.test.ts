import { describe, expect, test } from "bun:test";
import {
    getAllChargers,
    getOrCreateCharger,
    markChargerConnected,
    markChargerDisconnected,
    markChargerSeen,
    updateConnectorStatus,
} from "./charger-state";

describe("charger state", () => {
    test("tracks charger and connector lifecycle", () => {
        const chargerId = `test-${crypto.randomUUID()}`;

        expect(getOrCreateCharger(chargerId)).toMatchObject({
            chargerId,
            connected: false,
            connectors: {},
        });

        expect(markChargerConnected(chargerId).connected).toBe(true);
        expect(markChargerSeen(chargerId).lastSeenAt).toEqual(expect.any(String));

        updateConnectorStatus(chargerId, 1, "Available", "NoError");

        expect(getOrCreateCharger(chargerId).connectors["1"]).toMatchObject({
            connectorId: 1,
            status: "Available",
            errorCode: "NoError",
        });
        expect(getAllChargers().some((charger) => charger.chargerId === chargerId)).toBe(
            true,
        );

        expect(markChargerDisconnected(chargerId).connected).toBe(false);
    });
});
