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

    // Phase 1 baseline is intentionally unfair; Phase 2 replaces it with smart allocation.
    for (const charger of chargers) {
        if (charger.status !== "Charging") {
            continue;
        }

        const suppliedPowerKw = Math.min(
            charger.requestedPowerKw,
            remainingPowerKw,
        );
        allocations.set(charger.id, suppliedPowerKw);
        remainingPowerKw -= suppliedPowerKw;
    }

    return allocations;
}
