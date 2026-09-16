import { describe, expect, test } from "bun:test";
import { chargerRoutes } from "./charger.routes";
import {
    markChargerConnected,
    updateConnectorStatus,
} from "../modules/chargers/charger-state";

describe("charger routes", () => {
    test("returns live charger state", async () => {
        const chargerId = `test-${crypto.randomUUID()}`;

        markChargerConnected(chargerId);
        updateConnectorStatus(chargerId, 1, "Available", "NoError");

        const response = await chargerRoutes.request("/chargers");
        const body = (await response.json()) as {
            chargers: Array<{
                chargerId: string;
                connected: boolean;
                connectors: Record<string, { status: string }>;
            }>;
        };
        const charger = body.chargers.find(
            (entry) => entry.chargerId === chargerId,
        );

        expect(response.status).toBe(200);
        expect(charger).toMatchObject({
            chargerId,
            connected: true,
            connectors: {
                "1": { status: "Available" },
            },
        });
    });

    test("rejects invalid station settings before database access", async () => {
        const response = await chargerRoutes.request("/site", {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                powerLimitKw: -1,
                tariffPaisePerKwh: 800,
            }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: "Invalid site capacity or tariff",
        });
    });
});
