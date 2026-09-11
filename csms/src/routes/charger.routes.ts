import { Hono } from "hono";
import { getAllChargers } from "../modules/chargers/charger-state";
import { db } from "../infrastructure/database/db";

export const chargerRoutes = new Hono();

chargerRoutes.get("/chargers", (c) => {
  return c.json({
    chargers: getAllChargers(),
  });
});

chargerRoutes.get("/sessions/:transactionId/invoice", async (c) => {
  const transactionId = Number(c.req.param("transactionId"));

  if (!Number.isInteger(transactionId) || transactionId < 1) {
    return c.json({ error: "Invalid transactionId" }, 400);
  }

  try {
    const invoice = await db.orm.public.Invoice.select(
      "id",
      "sessionId",
      "energyWh",
      "tariffPaisePerKwh",
      "amountPaise",
      "currency",
      "status",
      "issuedAt",
    )
      .where({ sessionId: transactionId })
      .first();

    if (!invoice) {
      return c.json({ error: "Invoice not found" }, 404);
    }

    return c.json({
      invoice: {
        ...invoice,
        energyKwh: invoice.energyWh / 1000,
        amountInr: (invoice.amountPaise / 100).toFixed(2),
      },
    });
  } catch (error) {
    console.error(
      `Failed to load invoice for transaction ${transactionId}:`,
      error,
    );

    return c.json({ error: "Could not load invoice" }, 500);
  }
});
