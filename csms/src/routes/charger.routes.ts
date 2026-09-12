import { Hono } from "hono";
import { getAllChargers } from "../modules/chargers/charger-state";
import { rebalanceSite } from "../modules/load-balancer/load-balancer-client";
import { db } from "../infrastructure/database/db";

export const chargerRoutes = new Hono();

chargerRoutes.get("/chargers", (c) => {
    return c.json({
        chargers: getAllChargers(),
    });
});

chargerRoutes.get("/site", async (c) => {
    try {
        const site = await db.orm.public.Site.select(
            "id",
            "name",
            "powerLimitKw",
            "tariffPaisePerKwh",
        ).first();

        if (!site) {
            return c.json({ error: "Site not configured" }, 404);
        }

        return c.json({ site });
    } catch (error) {
        console.error("Failed to load site configuration:", error);
        return c.json({ error: "Could not load site configuration" }, 500);
    }
});

chargerRoutes.patch("/site", async (c) => {
    const payload = await c.req
        .json<{
            powerLimitKw?: unknown;
            tariffPaisePerKwh?: unknown;
        }>()
        .catch(() => null);

    if (
        !payload ||
        typeof payload.powerLimitKw !== "number" ||
        !Number.isFinite(payload.powerLimitKw) ||
        payload.powerLimitKw < 0 ||
        typeof payload.tariffPaisePerKwh !== "number" ||
        !Number.isInteger(payload.tariffPaisePerKwh) ||
        payload.tariffPaisePerKwh < 0
    ) {
        return c.json({ error: "Invalid site capacity or tariff" }, 400);
    }

    try {
        const currentSite = await db.orm.public.Site.select("id").first();

        if (!currentSite) {
            return c.json({ error: "Site not configured" }, 404);
        }

        await db.orm.public.Site.where({ id: currentSite.id }).update({
            powerLimitKw: payload.powerLimitKw,
            tariffPaisePerKwh: payload.tariffPaisePerKwh,
        });

        const site = await db.orm.public.Site.select(
            "id",
            "name",
            "powerLimitKw",
            "tariffPaisePerKwh",
        )
            .where({ id: currentSite.id })
            .first();

        void rebalanceSite(currentSite.id);

        return c.json({ site });
    } catch (error) {
        console.error("Failed to update site configuration:", error);
        return c.json({ error: "Could not update site configuration" }, 500);
    }
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
