import { expect, test } from "bun:test";

import { allocateFirstComePower } from "./baseline-power";

test("first arrivals consume the Phase 1 site capacity", () => {
    const allocations = allocateFirstComePower(
        [1, 2, 3, 4].map((number) => ({
            id: `car-${number}`,
            status: "Charging",
        })),
        100,
        50,
    );

    expect([...allocations.values()]).toEqual([50, 50, 0, 0]);
    expect([...allocations.values()].reduce((total, power) => total + power, 0)).toBe(100);
});
