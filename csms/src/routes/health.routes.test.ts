import { describe, expect, test } from "bun:test";
import { healthRoutes } from "./health.routes";

describe("health routes", () => {
    test("serves the root greeting", async () => {
        const response = await healthRoutes.request("/");

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("Hello Hono!");
    });

    test("reports a healthy CSMS", async () => {
        const response = await healthRoutes.request("/healthz");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            status: "ok",
            service: "voltgrid-csms",
        });
    });
});
