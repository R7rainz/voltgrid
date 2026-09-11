import { db } from "../../infrastructure/database/db";

type LoadBalancerResponse = {
    sitePowerLimitKw: number;
    totalAllocatedPowerKw: number;
    allocations: Array<{
        chargerId: string;
        allocatedPowerKw: number;
    }>;
};

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

        const [site, chargers, sessions] = await Promise.all([
            db.orm.public.Site.select("powerLimitKw")
                .where({ id: siteId })
                .first(),
            db.orm.public.Charger.select("id", "chargePointId", "siteId").all(),
            db.orm.public.ChargingSession.select(
                "chargerId",
                "status",
            )
                .where({ status: "Active" })
                .all(),
        ]);

        if (!site) {
            throw new Error(`Site ${siteId} was not found`);
        }

        const siteChargerIds = new Set(
            chargers
                .filter((charger) => charger.siteId === siteId)
                .map((charger) => charger.id),
        );
        const chargerNames = new Map(
            chargers.map((charger) => [charger.id, charger.chargePointId]),
        );
        const activeChargers = sessions
            .filter((session) => siteChargerIds.has(session.chargerId))
            .map((session) => ({
                chargerId: chargerNames.get(session.chargerId),
                requestedPowerKw: chargerMaxPowerKw,
                maxPowerKw: chargerMaxPowerKw,
            }))
            .filter(
                (charger): charger is {
                    chargerId: string;
                    requestedPowerKw: number;
                    maxPowerKw: number;
                } => charger.chargerId !== undefined,
            );

        if (activeChargers.length === 0) {
            return;
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

        console.log(
            `Load balancing applied for site ${siteId}: ${allocation.totalAllocatedPowerKw}/${allocation.sitePowerLimitKw} kW`,
            allocation.allocations,
        );
    } catch (error) {
        console.error(`Load balancing failed for site ${siteId}:`, error);
    }
}
