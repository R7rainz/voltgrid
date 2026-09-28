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

test("does not partially serve a request that exceeds the remaining site power", () => {
    const allocations = allocateFirstComePower(
        [70, 50, 40].map((requestedPowerKw, index) => ({
            id: `car-${index + 1}`,
            status: "Charging",
            requestedPowerKw,
        })),
        100,
    );

    expect([...allocations.values()]).toEqual([70, 0, 0]);
});

test("three 40 kW requests at a 100 kW site leave the third car waiting", () => {
    const allocations = allocateFirstComePower(
        [1, 2, 3].map((number) => ({
            id: `car-${number}`,
            status: "Charging",
            requestedPowerKw: 40,
        })),
        100,
    );

    expect([...allocations.values()]).toEqual([40, 40, 0]);
    expect([...allocations.values()].reduce((total, power) => total + power, 0)).toBe(80);
});
