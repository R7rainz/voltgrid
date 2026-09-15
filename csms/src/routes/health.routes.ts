import { Hono } from "hono";

export const healthRoutes = new Hono();

const healthHandler = (c: { json: (value: object) => Response }) => {
    return c.json({
        status: "ok",
        service: "voltgrid-csms",
    });
};

healthRoutes.get("/", (c) => {
    return c.text("Hello Hono!");
});

healthRoutes.get("/health", healthHandler);
healthRoutes.get("/healthz", healthHandler);
