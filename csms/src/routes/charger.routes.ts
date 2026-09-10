import { Hono } from "hono";
import { getAllChargers } from "../modules/chargers/charger-state";

export const chargerRoutes = new Hono();

chargerRoutes.get("/chargers", (c) => {
  return c.json({
    chargers: getAllChargers(),
  });
});
