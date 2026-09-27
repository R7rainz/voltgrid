import { expect, test } from "bun:test";

import { allocateFirstComePower } from "./baseline-power";

test("first arrivals consume the Phase 1 site capacity", () => {
    const allocations = allocateFirstComePower(
        [1, 2, 3, 4].map((number) => ({
            id: `car-${number}`,
            status: "Charging",
            requestedPowerKw: 50,
        })),
        100,
    );

    expect([...allocations.values()]).toEqual([50, 50, 0, 0]);
    expect([...allocations.values()].reduce((total, power) => total + power, 0)).toBe(100);
});

test("applies each charging vehicle's own power request", () => {
    const allocations = allocateFirstComePower(
        [70, 50, 40].map((requestedPowerKw, index) => ({
            id: `car-${index + 1}`,
            status: "Charging",
            requestedPowerKw,
        })),
        100,
    );

    expect([...allocations.values()]).toEqual([70, 30, 0]);
});
