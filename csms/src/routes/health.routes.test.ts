import { describe, expect, test } from "bun:test";
import { healthRoutes } from "./health.routes";

describe("health routes", () => {
    test("reports a healthy CSMS", async () => {
        const response = await healthRoutes.request("/healthz");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            status: "ok",
            service: "voltgrid-csms",
        });
    });
});
