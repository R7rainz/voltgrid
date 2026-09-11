import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
    return c.text("Hello Hono!");
});

healthRoutes.get("/healthz", (c) => {
    return c.json({
        status: "ok",
        service: "voltgrid-csms",
    });
});
