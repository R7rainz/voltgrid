import { db } from "../../infrastructure/database/db";
import { getAllChargers, updateChargerAllocation } from "../chargers/charger-state";
import { sendChargerCall } from "../chargers/charger-connections";
import type { JsonValue } from "@prisma/orm-postgres/target/codec-types";

type Demand = {
    chargerId: string;
    requestedPowerKw: number;
    maxPowerKw: number;
};

export type LoadBalancerResponse = {
    sitePowerLimitKw: number;
    totalAllocatedPowerKw: number;
    allocations: Array<{ chargerId: string; allocatedPowerKw: number }>;
};

const loadBalancerUrl = process.env.LOAD_BALANCER_URL ?? "http://localhost:8787";
const defaultPowerKw = Number(process.env.CHARGER_MAX_POWER_KW ?? 50);
const pending = new Set<number>();
const running = new Map<number, Promise<LoadBalancerResponse | undefined>>();

function profilePayload(connectorId: number, powerKw: number) {
    return {
        connectorId,
        csChargingProfiles: {
            chargingProfileId: 1,
            stackLevel: 0,
            chargingProfilePurpose: "TxProfile",
            chargingProfileKind: "Absolute",
            chargingSchedule: {
                chargingRateUnit: "W",
                chargingSchedulePeriod: [{
                    startPeriod: 0,
                    limit: Math.round(powerKw * 1000),
                }],
            },
        },
    };
}

function validatedAllocations(
    value: unknown,
    sitePowerLimitKw: number,
    demands: Demand[],
): Map<string, number> {
    if (!value || typeof value !== "object") throw new Error("Invalid allocator response");
    const response = value as LoadBalancerResponse;
    if (!Array.isArray(response.allocations) || response.allocations.length !== demands.length) {
        throw new Error("Allocator omitted a charger");
    }

    const demandById = new Map(demands.map((charger) => [charger.chargerId, charger.requestedPowerKw]));
    const allocations = new Map<string, number>();
    let total = 0;
    for (const entry of response.allocations) {
        if (!entry || !demandById.has(entry.chargerId) || allocations.has(entry.chargerId) ||
            typeof entry.allocatedPowerKw !== "number" || !Number.isFinite(entry.allocatedPowerKw) ||
            entry.allocatedPowerKw < 0 || entry.allocatedPowerKw > demandById.get(entry.chargerId)! + 1e-6) {
            throw new Error("Allocator returned an invalid charger allocation");
        }
        // Charging profiles use integer watts; rounding down preserves the site limit.
        const powerKw = Math.floor(entry.allocatedPowerKw * 1000) / 1000;
        allocations.set(entry.chargerId, powerKw);
        total += powerKw;
    }
    if (total > sitePowerLimitKw + 1e-6) {
        throw new Error("Allocator exceeded the site power limit");
    }
    return allocations;
}

async function rebalanceOnce(siteId: number): Promise<LoadBalancerResponse> {
    if (!Number.isFinite(defaultPowerKw) || defaultPowerKw < 0) {
        throw new Error("CHARGER_MAX_POWER_KW must be non-negative");
    }

    const [site, chargers, sessions, connectors] = await Promise.all([
        db.orm.public.Site.select("powerLimitKw").where({ id: siteId }).first(),
        db.orm.public.Charger.select("id", "chargePointId", "siteId", "connected").all(),
        db.orm.public.ChargingSession.select("chargerId", "connectorId")
            .where({ status: "Active" }).all(),
        db.orm.public.Connector.select("id", "connectorNumber", "status", "errorCode").all(),
    ]);
    if (!site) throw new Error(`Site ${siteId} was not found`);

    const liveState = new Map(getAllChargers().map((charger) => [charger.chargerId, charger]));
    const siteChargers = chargers.filter((charger) =>
        charger.siteId === siteId && charger.connected &&
        liveState.get(charger.chargePointId)?.connected,
    );
    const byId = new Map(siteChargers.map((charger) => [charger.id, charger]));
    const connectorById = new Map(connectors.map((connector) => [connector.id, connector]));
    const connectorByCharger = new Map<string, number>();
    const demands: Demand[] = [];

    for (const session of sessions) {
        const charger = byId.get(session.chargerId);
        if (!charger || connectorByCharger.has(charger.chargePointId)) continue;
        const connector = connectorById.get(session.connectorId);
        if (!connector) continue;
        connectorByCharger.set(charger.chargePointId, connector.connectorNumber);
        const unavailable = connector.status === "Faulted" || connector.status === "Unavailable" ||
            connector.errorCode !== "NoError";
        const requestedPowerKw = unavailable ? 0 :
            (liveState.get(charger.chargePointId)?.requestedPowerKw ?? defaultPowerKw);
        demands.push({ chargerId: charger.chargePointId, requestedPowerKw, maxPowerKw: requestedPowerKw });
    }

    let allocation: LoadBalancerResponse = {
        sitePowerLimitKw: site.powerLimitKw,
        totalAllocatedPowerKw: 0,
        allocations: [],
    };
    if (demands.length > 0) {
        const response = await fetch(`${loadBalancerUrl}/v1/allocate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sitePowerLimitKw: site.powerLimitKw, activeChargers: demands }),
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`Load balancer returned HTTP ${response.status}`);
        allocation = await response.json() as LoadBalancerResponse;
    }

    const target = validatedAllocations(allocation, site.powerLimitKw, demands);
    const changes = demands.map((charger) => ({
        chargerId: charger.chargerId,
        connectorId: connectorByCharger.get(charger.chargerId)!,
        previous: liveState.get(charger.chargerId)?.allocatedPowerKw ?? 0,
        next: target.get(charger.chargerId) ?? 0,
    }));

    // Apply decreases before increases so a rebalance does not briefly overdraw the site.
    for (const change of [
        ...changes.filter((change) => change.next < change.previous),
        ...changes.filter((change) => change.next > change.previous),
    ]) {
        const payload = profilePayload(change.connectorId, change.next);
        const response = await sendChargerCall(
            change.chargerId,
            "SetChargingProfile",
            payload,
        );
        if (!response || typeof response !== "object" ||
            (response as { status?: unknown }).status !== "Accepted") {
            throw new Error(`${change.chargerId} rejected SetChargingProfile`);
        }
        await db.orm.public.OcppMessage.create({
            messageId: `profile:${crypto.randomUUID()}`,
            action: "SetChargingProfile",
            direction: "outbound",
            payload: payload as JsonValue,
            chargerId: siteChargers.find((item) => item.chargePointId === change.chargerId)!.id,
        });
        updateChargerAllocation(change.chargerId, change.next);
        console.log(`Charging profile applied to ${change.chargerId}: ${change.next} kW`);
    }
    console.log(`Go allocation for site ${siteId}: ${[...target.values()].reduce((sum, power) => sum + power, 0)}/${site.powerLimitKw} kW`);
    return allocation;
}

export function rebalanceSite(siteId: number): Promise<LoadBalancerResponse | undefined> {
    pending.add(siteId);
    const current = running.get(siteId);
    if (current) return current;

    const task = (async () => {
        let allocation: LoadBalancerResponse | undefined;
        do {
            pending.delete(siteId);
            try {
                allocation = await rebalanceOnce(siteId);
            } catch (error) {
                console.error(`Load balancing failed for site ${siteId}:`, error);
            }
        } while (pending.has(siteId));
        return allocation;
    })().finally(() => running.delete(siteId));
    running.set(siteId, task);
    return task;
}
