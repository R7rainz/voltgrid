import { db } from "../../infrastructure/database/db";
import {
    getAllChargers,
    updateChargerAllocation,
} from "../chargers/charger-state";
import { sendChargerCall } from "../chargers/charger-connections";

export type LoadBalancerResponse = {
    sitePowerLimitKw: number;
    totalAllocatedPowerKw: number;
    allocations: Array<{
        chargerId: string;
        allocatedPowerKw: number;
    }>;
};

type SiteCharger = {
    id: number;
    chargePointId: string;
    connected: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profilePayload(connectorId: number, allocatedPowerKw: number) {
    return {
        connectorId,
        csChargingProfiles: {
            chargingProfileId: 1,
            stackLevel: 0,
            chargingProfilePurpose: "TxProfile",
            chargingProfileKind: "Absolute",
            chargingSchedule: {
                chargingRateUnit: "W",
                chargingSchedulePeriod: [
                    {
                        startPeriod: 0,
                        limit: Math.max(0, Math.round(allocatedPowerKw * 1000)),
                    },
                ],
            },
        },
    };
}

async function applyAllocations(
    siteChargers: SiteCharger[],
    allocations: LoadBalancerResponse["allocations"],
    connectorNumbers: Map<number, number>,
) {
    const allocatedByCharger = new Map(
        allocations.map((allocation) => [
            allocation.chargerId,
            allocation.allocatedPowerKw,
        ]),
    );

    await Promise.all(
        siteChargers.map(async (charger) => {
            const allocatedPowerKw = allocatedByCharger.get(charger.chargePointId) ?? 0;
            const connectorNumber = connectorNumbers.get(charger.id) ?? 1;

            try {
                const response = await sendChargerCall(
                    charger.chargePointId,
                    "SetChargingProfile",
                    profilePayload(connectorNumber, allocatedPowerKw),
                );

                if (!isObject(response) || response.status !== "Accepted") {
                    throw new Error("charger rejected SetChargingProfile");
                }

                updateChargerAllocation(
                    charger.chargePointId,
                    allocatedPowerKw,
                );
                console.log(
                    `Charging profile applied to ${charger.chargePointId}: ${allocatedPowerKw} kW`,
                );
            } catch (error) {
                console.warn(
                    `Could not apply charging profile to ${charger.chargePointId}:`,
                    error,
                );
            }
        }),
    );
}

const loadBalancerUrl =
    process.env.LOAD_BALANCER_URL ?? "http://localhost:8787";
const chargerMaxPowerKw = Number(
    process.env.CHARGER_MAX_POWER_KW ?? 50,
);

export async function rebalanceSite(siteId: number) {
    try {
        if (!Number.isFinite(chargerMaxPowerKw) || chargerMaxPowerKw < 0) {
            throw new Error("CHARGER_MAX_POWER_KW must be non-negative");
        }

        const [site, chargers, sessions, connectors] = await Promise.all([
            db.orm.public.Site.select("powerLimitKw")
                .where({ id: siteId })
                .first(),
            db.orm.public.Charger.select("id", "chargePointId", "siteId").all(),
            db.orm.public.ChargingSession.select(
                "chargerId",
                "connectorId",
                "status",
            )
                .where({ status: "Active" })
                .all(),
            db.orm.public.Connector.select(
                "id",
                "chargerId",
                "connectorNumber",
            ).all(),
        ]);

        if (!site) {
            throw new Error(`Site ${siteId} was not found`);
        }

        const siteChargers: SiteCharger[] = chargers
            .filter((charger) => charger.siteId === siteId)
            .map((charger) => ({
                id: charger.id,
                chargePointId: charger.chargePointId,
                connected: charger.connected,
            }));
        const siteChargerById = new Map(
            siteChargers.map((charger) => [charger.id, charger]),
        );
        const siteChargerNames = new Set(
            siteChargers.map((charger) => charger.chargePointId),
        );
        const connectorNumbers = new Map(
            connectors.map((connector) => [connector.id, connector.connectorNumber]),
        );
        const chargerConnectorNumbers = new Map<number, number>();

        for (const connector of connectors) {
            if (!chargerConnectorNumbers.has(connector.chargerId)) {
                chargerConnectorNumbers.set(
                    connector.chargerId,
                    connector.connectorNumber,
                );
            }
        }
        const chargerNames = new Map(
            chargers.map((charger) => [charger.id, charger.chargePointId]),
        );
        const activeConnectorNumbers = new Map<string, number>();
        const activeChargerIds = new Set<string>();
        const activeChargers = sessions
            .filter((session) => siteChargerById.get(session.chargerId)?.connected)
            .map((session) => {
                const chargerId = chargerNames.get(session.chargerId);
                const connectorNumber = connectorNumbers.get(session.connectorId);

                if (chargerId && connectorNumber !== undefined) {
                    activeConnectorNumbers.set(chargerId, connectorNumber);
                }

                return {
                    chargerId,
                    requestedPowerKw: chargerMaxPowerKw,
                    maxPowerKw: chargerMaxPowerKw,
                };
            })
            .filter(
                (charger): charger is {
                    chargerId: string;
                    requestedPowerKw: number;
                    maxPowerKw: number;
                } => {
                    if (!charger.chargerId || activeChargerIds.has(charger.chargerId)) {
                        return false;
                    }

                    activeChargerIds.add(charger.chargerId);
                    return true;
                },
            );

        for (const charger of getAllChargers()) {
            if (siteChargerNames.has(charger.chargerId)) {
                updateChargerAllocation(charger.chargerId, 0);
            }
        }

        if (activeChargers.length === 0) {
            const allocation = {
                sitePowerLimitKw: site.powerLimitKw,
                totalAllocatedPowerKw: 0,
                allocations: [],
            } satisfies LoadBalancerResponse;

            await applyAllocations(
                siteChargers,
                allocation.allocations,
                chargerConnectorNumbers,
            );
            return allocation;
        }

        const response = await fetch(`${loadBalancerUrl}/v1/allocate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                sitePowerLimitKw: site.powerLimitKw,
                activeChargers,
            }),
            signal: AbortSignal.timeout(1500),
        });

        if (!response.ok) {
            throw new Error(`Load balancer returned HTTP ${response.status}`);
        }

        const allocation = (await response.json()) as LoadBalancerResponse;

        await applyAllocations(
            siteChargers,
            allocation.allocations,
            new Map(
                siteChargers.map((charger) => [
                    charger.id,
                    activeConnectorNumbers.get(charger.chargePointId) ??
                        chargerConnectorNumbers.get(charger.id) ??
                        1,
                ]),
            ),
        );

        console.log(
            `Load balancing applied for site ${siteId}: ${allocation.totalAllocatedPowerKw}/${allocation.sitePowerLimitKw} kW`,
            allocation.allocations,
        );
        return allocation;
    } catch (error) {
        console.error(`Load balancing failed for site ${siteId}:`, error);
        return undefined;
    }
}
