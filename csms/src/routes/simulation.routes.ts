import { Hono } from "hono";

const loadBalancerUrl =
    process.env.LOAD_BALANCER_URL ?? "http://localhost:8787";

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const simulationRoutes = new Hono();

simulationRoutes.post("/simulation/compare", async (c) => {
    const payload = await c.req.json<unknown>().catch(() => null);
    if (!isObject(payload)) {
        return c.json({ error: "Simulation request must be a JSON object" }, 400);
    }

    try {
        const response = await fetch(loadBalancerUrl + "/v1/compare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5_000),
        });
        const body = await response.text();

        return new Response(body, {
            status: response.status,
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        console.error("Failed to compare charging policies:", error);
        return c.json({ error: "Policy evaluator unavailable" }, 503);
    }
});
