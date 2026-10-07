import { describe, expect, test } from "bun:test";
import { simulationRoutes } from "./simulation.routes";

describe("simulation routes", () => {
    test("rejects a non-object simulation request", async () => {
        const response = await simulationRoutes.request("/simulation/compare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([]),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: "Simulation request must be a JSON object",
        });
    });
});
