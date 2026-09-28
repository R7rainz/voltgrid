type ChargerDemand = {
    id: string;
    status: string;
    requestedPowerKw: number;
};

export function allocateFirstComePower(
    chargers: ChargerDemand[],
    siteCapacityKw: number,
) {
    const allocations = new Map<string, number>();
    let remainingPowerKw = Math.max(0, siteCapacityKw);

    // Phase 1 grants whole requests in arrival order; Phase 2 replaces this with smart allocation.
    for (const charger of chargers) {
        if (charger.status !== "Charging") {
            continue;
        }

        const suppliedPowerKw =
            charger.requestedPowerKw <= remainingPowerKw
                ? charger.requestedPowerKw
                : 0;
        allocations.set(charger.id, suppliedPowerKw);
        remainingPowerKw -= suppliedPowerKw;
    }

    return allocations;
}
