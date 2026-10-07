import { Hono } from "hono";
import { cors } from "hono/cors";
import { chargerRoutes } from "./routes/charger.routes";
import { healthRoutes } from "./routes/health.routes";
import { ocppRoutes } from "./routes/ocpp.routes";
import { simulationRoutes } from "./routes/simulation.routes";

const app = new Hono();

app.use(
    "/api/*",
    cors({
        origin: Bun.env.DASHBOARD_ORIGIN ?? "http://localhost:9000",
    }),
);

app.route("/", healthRoutes);
app.route("/api", chargerRoutes);
app.route("/api", simulationRoutes);
app.route("/", ocppRoutes);

export { app };
