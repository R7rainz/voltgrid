import { Hono } from "hono";
import { chargerRoutes } from "./routes/charger.routes";
import { healthRoutes } from "./routes/health.routes";
import { ocppRoutes } from "./routes/ocpp.routes";

const app = new Hono();

app.route("/", healthRoutes);
app.route("/api", chargerRoutes);
app.route("/", ocppRoutes);

export { app };
