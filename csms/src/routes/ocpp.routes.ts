import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import {
  markChargerConnected,
  markChargerDisconnected,
  markChargerSeen,
  updateConnectorStatus,
} from "../modules/chargers/charger-state";
import { db } from "../infrastructure/database/db";
import type { JsonValue } from "@prisma/orm-postgres/target/codec-types";

export const ocppRoutes = new Hono();

ocppRoutes.get(
  "/ocpp/:chargerId",
  upgradeWebSocket((c) => {
    const chargerId = c.req.param("chargerId");

    return {
      onOpen(_event, ws) {
        markChargerConnected(String(chargerId));
        console.log(`Charger connected: ${chargerId}`);
        ws.send(`Connected to VoltGrid: ${chargerId}`);
      },

      async onMessage(event, ws) {
        if (typeof event.data !== "string") {
          return;
        }

        let message: unknown;

        try {
          message = JSON.parse(event.data);
        } catch {
          console.log("Invalid JSON received");
          return;
        }

        if (!Array.isArray(message) || message.length < 4) {
          console.log("Invalid OCPP message");
          return;
        }

        const [messageType, uniqueId, action, payload] = message;

        if (
          messageType !== 2 ||
          typeof uniqueId !== "string" ||
          typeof action !== "string"
        ) {
          console.log("Invalid OCPP Call message");
          return;
        }

        console.log(`Received ${action} from ${chargerId}`);

        markChargerSeen(String(chargerId));

        if (action === "Heartbeat") {
          ws.send(
            JSON.stringify([
              3,
              uniqueId,
              {
                currentTime: new Date().toISOString(),
              },
            ]),
          );

          console.log(`Heartbeat received from ${chargerId}`);
          return;
        }

        if (action === "StatusNotification") {
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            console.log("Invalid StatusNotification payload");
            return;
          }

          const statusPayload = payload as {
            connectorId?: number;
            status?: string;
            errorCode?: string;
          };

          const connectorId = statusPayload.connectorId;
          const status = statusPayload.status;
          const errorCode = statusPayload.errorCode;

          if (
            typeof connectorId !== "number" ||
            typeof status !== "string" ||
            typeof errorCode !== "string"
          ) {
            console.log("Invalid StatusNotification payload");
            return;
          }

          try {
            const now = new Date().toISOString();

            const persisted = await db.transaction(async (tx) => {
              const charger = await tx.orm.public.Charger.select("id")
                .where({ chargePointId: String(chargerId) })
                .first();

              if (!charger) {
                return false;
              }

              await tx.orm.public.Connector.upsert({
                conflictOn: {
                  chargerId: charger.id,
                  connectorNumber: connectorId,
                },
                create: {
                  chargerId: charger.id,
                  connectorNumber: connectorId,
                  status,
                  errorCode,
                },
                update: {
                  status,
                  errorCode,
                },
              });

              await tx.orm.public.Charger.where({ id: charger.id }).update({
                connected: true,
                lastSeenAt: now,
              });

              await tx.orm.public.OcppMessage.upsert({
                conflictOn: {
                  chargerId: charger.id,
                  messageId: uniqueId,
                },
                create: {
                  messageId: uniqueId,
                  action,
                  direction: "inbound",
                  payload: payload as JsonValue,
                  chargerId: charger.id,
                },
                update: {
                  action,
                  direction: "inbound",
                  payload: payload as JsonValue,
                },
              });

              return true;
            });

            if (!persisted) {
              console.error(
                `Cannot persist status for unknown charger ${chargerId}`,
              );
              ws.send(JSON.stringify([3, uniqueId, {}]));
              return;
            }

            updateConnectorStatus(
              String(chargerId),
              connectorId,
              status,
              errorCode,
            );

            console.log(`Connector ${connectorId} on ${chargerId}: ${status}`);
            console.log(`Charger error code: ${errorCode}`);

            ws.send(JSON.stringify([3, uniqueId, {}]));
          } catch (error) {
            console.error(
              `Failed to persist status for charger ${chargerId}:`,
              error,
            );
            ws.send(JSON.stringify([3, uniqueId, {}]));
          }

          return;
        }

        if (action === "BootNotification") {
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            console.log("Invalid BootNotification payload");
            return;
          }

          const bootPayload = payload as {
            chargePointVendor?: unknown;
            chargePointModel?: unknown;
          };

          if (
            typeof bootPayload.chargePointVendor !== "string" ||
            typeof bootPayload.chargePointModel !== "string"
          ) {
            console.log("Invalid BootNotification payload");
            return;
          }

          const vendor = bootPayload.chargePointVendor;
          const model = bootPayload.chargePointModel;

          try {
            const now = new Date().toISOString();

            const persisted = await db.transaction(async (tx) => {
              const site = await tx.orm.public.Site.select("id").first();

              if (!site) {
                return false;
              }

              const charger = await tx.orm.public.Charger.select("id").upsert({
                conflictOn: {
                  chargePointId: String(chargerId),
                },
                create: {
                  chargePointId: String(chargerId),
                  vendor,
                  model,
                  connected: true,
                  lastSeenAt: now,
                  siteId: site.id,
                },
                update: {
                  vendor,
                  model,
                  connected: true,
                  lastSeenAt: now,
                },
              });

              await tx.orm.public.OcppMessage.upsert({
                conflictOn: {
                  chargerId: charger.id,
                  messageId: uniqueId,
                },
                create: {
                  messageId: uniqueId,
                  action,
                  direction: "inbound",
                  payload: payload as JsonValue,
                  chargerId: charger.id,
                },
                update: {
                  action,
                  direction: "inbound",
                  payload: payload as JsonValue,
                },
              });

              return true;
            });

            if (!persisted) {
              console.error("No site configured for charger registration");
              ws.send(
                JSON.stringify([
                  3,
                  uniqueId,
                  {
                    status: "Rejected",
                    currentTime: new Date().toISOString(),
                    interval: 300,
                  },
                ]),
              );
              return;
            }

            ws.send(
              JSON.stringify([
                3,
                uniqueId,
                {
                  status: "Accepted",
                  currentTime: now,
                  interval: 300,
                },
              ]),
            );

            console.log(`BootNotification persisted for ${chargerId}`);
          } catch (error) {
            console.error(`Failed to persist charger ${chargerId}:`, error);
            ws.send(
              JSON.stringify([
                3,
                uniqueId,
                {
                  status: "Rejected",
                  currentTime: new Date().toISOString(),
                  interval: 300,
                },
              ]),
            );
          }

          return;
        }

        if (action === "StartTransaction") {
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            console.log("Invalid StartTransaction payload");
            return;
          }

          const startPayload = payload as {
            connectorId?: unknown;
            idTag?: unknown;
            meterStart?: unknown;
            timestamp?: unknown;
          };

          const connectorId = startPayload.connectorId;
          const idTag = startPayload.idTag;
          const meterStart = startPayload.meterStart;
          const timestamp = startPayload.timestamp;

          if (
            typeof connectorId !== "number" ||
            !Number.isInteger(connectorId) ||
            connectorId < 1 ||
            typeof idTag !== "string" ||
            idTag.trim().length === 0 ||
            typeof meterStart !== "number" ||
            !Number.isInteger(meterStart) ||
            meterStart < 0 ||
            typeof timestamp !== "string" ||
            Number.isNaN(Date.parse(timestamp))
          ) {
            console.log("Invalid StartTransaction payload");
            return;
          }

          try {
            const now = new Date().toISOString();
            const startAt = new Date(timestamp).toISOString();

            const result = await db.transaction(async (tx) => {
              const charger = await tx.orm.public.Charger.select("id")
                .where({
                  chargePointId: String(chargerId),
                })
                .first();

              if (!charger) {
                return {
                  status: "invalid" as const,
                  transactionId: 0,
                };
              }

              await tx.orm.public.OcppMessage.upsert({
                conflictOn: {
                  chargerId: charger.id,
                  messageId: uniqueId,
                },
                create: {
                  messageId: uniqueId,
                  action,
                  direction: "inbound",
                  payload: payload as JsonValue,
                  chargerId: charger.id,
                },
                update: {
                  action,
                  direction: "inbound",
                  payload: payload as JsonValue,
                },
              });

              const connector = await tx.orm.public.Connector.select("id")
                .where({
                  chargerId: charger.id,
                  connectorNumber: connectorId,
                })
                .first();

              if (!connector) {
                return {
                  status: "invalid" as const,
                  transactionId: 0,
                };
              }

              const activeSession =
                await tx.orm.public.ChargingSession.select("transactionId")
                  .where({
                    connectorId: connector.id,
                    status: "Active",
                  })
                  .first();

              if (activeSession) {
                return {
                  status: "ConcurrentTx" as const,
                  transactionId: activeSession.transactionId,
                };
              }
            });
          } catch (error) {}
        }

        ws.send(
          JSON.stringify([
            4,
            uniqueId,
            "NotImplemented",
            `Action ${action} is not implemented`,
            {},
          ]),
        );
      },

      onClose() {
        markChargerDisconnected(String(chargerId));
        console.log(`Charger disconnected: ${chargerId}`);
      },

      onError(error) {
        console.error(`Charger error: ${chargerId}`, error);
      },
    };
  }),
);
