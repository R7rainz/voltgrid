import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import {
  getAllChargers,
  markChargerConnected,
  markChargerDisconnected,
  markChargerSeen,
  updateConnectorStatus,
} from "./modules/chargers/charger-state";

const app = new Hono();

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.get("/healthz", (c) => {
  return c.json({
    status: "ok",
    service: "voltgrid-csms",
  });
});

app.get(
  "/ocpp/:chargerId",
  upgradeWebSocket((c) => {
    const chargerId = c.req.param("chargerId");

    return {
      onOpen(_event, ws) {
        markChargerConnected(String(chargerId));
        console.log(`Charger connected: ${chargerId}`);
        ws.send(`Connected to VoltGrid: ${chargerId}`);
      },

      onMessage(event, ws) {
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

          if (
            typeof statusPayload.connectorId !== "number" ||
            typeof statusPayload.status !== "string" ||
            typeof statusPayload.errorCode !== "string"
          ) {
            console.log("Invalid StatusNotification payload");
            return;
          }

          updateConnectorStatus(
            String(chargerId),
            statusPayload.connectorId,
            statusPayload.status,
            statusPayload.errorCode,
          );

          console.log(
            `Connector ${statusPayload.connectorId} on ${chargerId}: ${statusPayload.status}`,
          );
          console.log(`Charger error code: ${statusPayload.errorCode}`);

          ws.send(JSON.stringify([3, uniqueId, {}]));

          return;
        }

        if (action === "BootNotification") {
          ws.send(
            JSON.stringify([
              3,
              uniqueId,
              {
                status: "Accepted",
                currentTime: new Date().toISOString(),
                interval: 300,
              },
            ]),
          );

          console.log(`BootNotification accepted for ${chargerId}`);
          return;
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

app.get("/api/chargers", (c) => {
  return c.json({
    chargers: getAllChargers(),
  });
});

const port = Number(Bun.env.PORT ?? 8080);

export { app };
export default {
  port,
  fetch: app.fetch,
  websocket,
};
