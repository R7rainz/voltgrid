import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import {
    markChargerConnected,
    markChargerDisconnected,
    markChargerSeen,
    updateConnectorStatus,
} from "../modules/chargers/charger-state";
import {
    registerChargerSocket,
    resolveChargerCall,
    unregisterChargerSocket,
} from "../modules/chargers/charger-connections";
import { rebalanceSite } from "../modules/load-balancer/load-balancer-client";
import { db } from "../infrastructure/database/db";
import type { JsonValue } from "@prisma/orm-postgres/target/codec-types";

export const ocppRoutes = new Hono();

type Socket = {
    send(message: string): void;
};

type JsonObject = Record<string, unknown>;

const OCPP_STATUSES = new Set([
    "Available",
    "Preparing",
    "Charging",
    "SuspendedEV",
    "SuspendedEVSE",
    "Finishing",
    "Reserved",
    "Unavailable",
    "Faulted",
]);

const OCPP_ERROR_CODES = new Set([
    "ConnectorLockFailure",
    "EVCommunicationError",
    "GroundFailure",
    "HighTemperature",
    "InternalError",
    "LocalListConflict",
    "NoError",
    "OtherError",
    "OverCurrentFailure",
    "OverVoltage",
    "PowerMeterFailure",
    "PowerSwitchFailure",
    "ReaderFailure",
    "ResetFailure",
    "UnderVoltage",
    "WeakSignal",
]);

const STOP_REASONS = new Set([
    "EmergencyStop",
    "EVDisconnected",
    "HardReset",
    "Local",
    "Other",
    "PowerLoss",
    "Reboot",
    "Remote",
    "SoftReset",
    "UnlockCommand",
]);

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseTimestamp(value: unknown): string | undefined {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value,
        )
    ) {
        return undefined;
    }

    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function isOcppStatus(value: unknown): value is string {
    return typeof value === "string" && OCPP_STATUSES.has(value);
}

function isOcppErrorCode(value: unknown): value is string {
    return typeof value === "string" && OCPP_ERROR_CODES.has(value);
}

function isStopReason(value: unknown): value is string {
    return typeof value === "string" && STOP_REASONS.has(value);
}

function sendCallError(
    ws: Socket,
    uniqueId: string,
    errorCode: string,
    description: string,
) {
    ws.send(JSON.stringify([4, uniqueId, errorCode, description, {}]));
}

async function markChargerOffline(chargerId: string) {
    try {
        const charger = await db.orm.public.Charger.select("id", "siteId")
            .where({ chargePointId: chargerId })
            .first();

        if (!charger) {
            return;
        }

        await db.orm.public.Charger.where({ id: charger.id }).update({
            connected: false,
        });
        void rebalanceSite(charger.siteId);
    } catch (error) {
        console.error(`Failed to mark charger ${chargerId} offline:`, error);
    }
}

ocppRoutes.get(
    "/ocpp/:chargerId",
    upgradeWebSocket((c) => {
        const chargerId = c.req.param("chargerId");

        return {
            onOpen(_event, ws) {
                registerChargerSocket(String(chargerId), ws);
                markChargerConnected(String(chargerId));
                console.log(`Charger connected: ${chargerId}`);
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

                if (!Array.isArray(message)) {
                    console.log("Invalid OCPP message");
                    return;
                }

                const [messageType, uniqueId, action, payload] = message;

                if (messageType === 3 || messageType === 4) {
                    resolveChargerCall(String(chargerId), message);
                    return;
                }

                if (message.length !== 4) {
                    console.log("Invalid OCPP Call length");

                    if (typeof uniqueId === "string" && uniqueId.length > 0) {
                        sendCallError(
                            ws,
                            uniqueId,
                            "ProtocolError",
                            "OCPP Call messages must contain exactly four items",
                        );
                    }

                    return;
                }

                if (
                    messageType !== 2 ||
                    typeof uniqueId !== "string" ||
                    uniqueId.length === 0 ||
                    typeof action !== "string" ||
                    action.length === 0
                ) {
                    console.log("Invalid OCPP Call message");

                    if (typeof uniqueId === "string" && uniqueId.length > 0) {
                        sendCallError(
                            ws,
                            uniqueId,
                            "ProtocolError",
                            "Invalid OCPP Call header",
                        );
                    }

                    return;
                }

                console.log(`Received ${action} from ${chargerId}`);

                markChargerSeen(String(chargerId));

                if (action === "Heartbeat") {
                    if (!isJsonObject(payload)) {
                        console.log("Invalid Heartbeat payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "FormationViolation",
                            "Heartbeat payload must be an object",
                        );
                        return;
                    }

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
                    if (!isJsonObject(payload)) {
                        console.log("Invalid StatusNotification payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "FormationViolation",
                            "StatusNotification payload must be an object",
                        );
                        return;
                    }

                    const statusPayload = payload as {
                        connectorId?: unknown;
                        status?: unknown;
                        errorCode?: unknown;
                    };

                    const connectorId = statusPayload.connectorId;
                    const status = statusPayload.status;
                    const errorCode = statusPayload.errorCode;

                    if (
                        !isNonNegativeInteger(connectorId) ||
                        !isOcppStatus(status) ||
                        !isOcppErrorCode(errorCode)
                    ) {
                        console.log("Invalid StatusNotification payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "PropertyConstraintViolation",
                            "StatusNotification contains an invalid connector, status, or errorCode",
                        );
                        return;
                    }

                    try {
                        const now = new Date().toISOString();

                        const persisted = await db.transaction(async (tx) => {
                            const charger = await tx.orm.public.Charger.select(
                                "id",
                            )
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

                            await tx.orm.public.Charger.where({
                                id: charger.id,
                            }).update({
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
                            sendCallError(
                                ws,
                                uniqueId,
                                "GenericError",
                                "Charger is not registered",
                            );
                            return;
                        }

                        updateConnectorStatus(
                            String(chargerId),
                            connectorId,
                            status,
                            errorCode,
                        );

                        console.log(
                            `Connector ${connectorId} on ${chargerId}: ${status}`,
                        );
                        console.log(`Charger error code: ${errorCode}`);

                        ws.send(JSON.stringify([3, uniqueId, {}]));
                    } catch (error) {
                        console.error(
                            `Failed to persist status for charger ${chargerId}:`,
                            error,
                        );
                        sendCallError(
                            ws,
                            uniqueId,
                            "GenericError",
                            "Could not persist StatusNotification",
                        );
                    }

                    return;
                }

                if (action === "BootNotification") {
                    if (!isJsonObject(payload)) {
                        console.log("Invalid BootNotification payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "FormationViolation",
                            "BootNotification payload must be an object",
                        );
                        return;
                    }

                    const bootPayload = payload as {
                        chargePointVendor?: unknown;
                        chargePointModel?: unknown;
                    };

                    if (
                        !isNonEmptyString(bootPayload.chargePointVendor) ||
                        !isNonEmptyString(bootPayload.chargePointModel)
                    ) {
                        console.log("Invalid BootNotification payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "PropertyConstraintViolation",
                            "BootNotification requires non-empty vendor and model",
                        );
                        return;
                    }

                    const vendor = bootPayload.chargePointVendor.trim();
                    const model = bootPayload.chargePointModel.trim();

                    try {
                        const now = new Date().toISOString();

                        const persisted = await db.transaction(async (tx) => {
                            const site =
                                await tx.orm.public.Site.select("id").first();

                            if (!site) {
                                return false;
                            }

                            const charger = await tx.orm.public.Charger.select(
                                "id",
                            ).upsert({
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
                            console.error(
                                "No site configured for charger registration",
                            );
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

                        console.log(
                            `BootNotification persisted for ${chargerId}`,
                        );
                    } catch (error) {
                        console.error(
                            `Failed to persist charger ${chargerId}:`,
                            error,
                        );
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
                    if (!isJsonObject(payload)) {
                        console.log("Invalid StartTransaction payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "FormationViolation",
                            "StartTransaction payload must be an object",
                        );
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
                    const startAt = parseTimestamp(timestamp);

                    if (
                        !isPositiveInteger(connectorId) ||
                        !isNonEmptyString(idTag) ||
                        !isNonNegativeInteger(meterStart) ||
                        startAt === undefined
                    ) {
                        console.log("Invalid StartTransaction payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "PropertyConstraintViolation",
                            "StartTransaction contains an invalid connector, idTag, meterStart, or timestamp",
                        );
                        return;
                    }

                    try {
                        const now = new Date().toISOString();

                        const result = await db.transaction(async (tx) => {
                            const charger = await tx.orm.public.Charger.select(
                                "id",
                                "siteId",
                            )
                                .where({
                                    chargePointId: String(chargerId),
                                })
                                .first();

                            if (!charger) {
                                return {
                                    status: "Invalid" as const,
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

                            const connector =
                                await tx.orm.public.Connector.select("id")
                                    .where({
                                        chargerId: charger.id,
                                        connectorNumber: connectorId,
                                    })
                                    .first();

                            if (!connector) {
                                return {
                                    status: "Invalid" as const,
                                    transactionId: 0,
                                };
                            }

                            const activeSession =
                                await tx.orm.public.ChargingSession.select(
                                    "transactionId",
                                )
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

                            const session =
                                await tx.orm.public.ChargingSession.create({
                                    idTag: idTag.trim(),
                                    status: "Active",
                                    meterStartWh: meterStart,
                                    lastMeterWh: meterStart,
                                    startedAt: startAt,
                                    chargerId: charger.id,
                                    connectorId: connector.id,
                                });

                            await tx.orm.public.Connector.where({
                                id: connector.id,
                            }).update({
                                status: "Charging",
                            });

                            await tx.orm.public.Charger.where({
                                id: charger.id,
                            }).update({
                                connected: true,
                                lastSeenAt: now,
                            });

                            return {
                                status: "Accepted" as const,
                                transactionId: session.transactionId,
                                siteId: charger.siteId,
                            };
                        });

                        if (result.status === "Accepted") {
                            updateConnectorStatus(
                                String(chargerId),
                                connectorId,
                                "Charging",
                                "NoError",
                            );
                        }

                        ws.send(
                            JSON.stringify([
                                3,
                                uniqueId,
                                {
                                    transactionId: result.transactionId,
                                    idTagInfo: {
                                        status: result.status,
                                    },
                                },
                            ]),
                        );

                        console.log(
                            `StartTransaction ${result.status.toLowerCase()} for ${chargerId}`,
                        );

                        if (result.status === "Accepted") {
                            void rebalanceSite(result.siteId);
                        }
                    } catch (error) {
                        console.error(
                            `Failed to start transaction for charger ${chargerId}:`,
                            error,
                        );

                        sendCallError(
                            ws,
                            uniqueId,
                            "GenericError",
                            "Could not persist StartTransaction",
                        );
                    }

                    return;
                }

                if (action === "MeterValues") {
                    if (!isJsonObject(payload)) {
                        console.log("Invalid MeterValues payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "FormationViolation",
                            "MeterValues payload must be an object",
                        );
                        return;
                    }

                    const meterPayload = payload as {
                        connectorId?: unknown;
                        transactionId?: unknown;
                        meterValue?: unknown;
                    };

                    const connectorId = meterPayload.connectorId;
                    const transactionId = meterPayload.transactionId;
                    const meterValues = meterPayload.meterValue;

                    if (
                        !isPositiveInteger(connectorId) ||
                        !isPositiveInteger(transactionId) ||
                        !Array.isArray(meterValues) ||
                        meterValues.length === 0
                    ) {
                        console.log("Invalid MeterValues payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "PropertyConstraintViolation",
                            "MeterValues requires a positive connectorId, transactionId, and meterValue array",
                        );
                        return;
                    }

                    let meterWh: number | undefined;
                    let recordedAt: string | undefined;

                    for (const meterValue of meterValues) {
                        if (
                            typeof meterValue !== "object" ||
                            meterValue === null ||
                            Array.isArray(meterValue)
                        ) {
                            continue;
                        }

                        const meterValuePayload = meterValue as {
                            timestamp?: unknown;
                            sampledValue?: unknown;
                        };

                        const timestamp = parseTimestamp(
                            meterValuePayload.timestamp,
                        );

                        if (
                            timestamp === undefined ||
                            !Array.isArray(meterValuePayload.sampledValue)
                        ) {
                            continue;
                        }

                        for (const sampledValue of meterValuePayload.sampledValue) {
                            if (
                                typeof sampledValue !== "object" ||
                                sampledValue === null ||
                                Array.isArray(sampledValue)
                            ) {
                                continue;
                            }

                            const sampledValuePayload = sampledValue as {
                                value?: unknown;
                                unit?: unknown;
                                measurand?: unknown;
                            };

                            if (
                                typeof sampledValuePayload.value !== "string" ||
                                sampledValuePayload.value.trim().length === 0 ||
                                (sampledValuePayload.unit !== undefined &&
                                    sampledValuePayload.unit !== "Wh") ||
                                (sampledValuePayload.measurand !== undefined &&
                                    sampledValuePayload.measurand !==
                                        "Energy.Active.Import.Register")
                            ) {
                                continue;
                            }

                            const parsedMeterWh = Number(
                                sampledValuePayload.value,
                            );

                            if (
                                !Number.isInteger(parsedMeterWh) ||
                                parsedMeterWh < 0
                            ) {
                                continue;
                            }

                            meterWh = parsedMeterWh;
                            recordedAt = timestamp;

                            break;
                        }

                        if (meterWh !== undefined) {
                            break;
                        }
                    }

                    if (meterWh === undefined) {
                        console.log(
                            "No valid energy reading found in MeterValues",
                        );
                        sendCallError(
                            ws,
                            uniqueId,
                            "PropertyConstraintViolation",
                            "MeterValues must contain a valid Wh energy reading and timestamp",
                        );
                        return;
                    }

                    const readingWh = meterWh;
                    const readingAt = recordedAt ?? new Date().toISOString();

                    try {
                        const now = new Date().toISOString();

                        const persisted = await db.transaction(async (tx) => {
                            const charger = await tx.orm.public.Charger.select(
                                "id",
                            )
                                .where({
                                    chargePointId: String(chargerId),
                                })
                                .first();

                            if (!charger) {
                                return false;
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

                            const connector =
                                await tx.orm.public.Connector.select("id")
                                    .where({
                                        chargerId: charger.id,
                                        connectorNumber: connectorId,
                                    })
                                    .first();

                            if (!connector) {
                                return false;
                            }

                            const session =
                                await tx.orm.public.ChargingSession.select(
                                    "transactionId",
                                    "meterStartWh",
                                    "lastMeterWh",
                                )
                                    .where({
                                        transactionId,
                                        chargerId: charger.id,
                                        connectorId: connector.id,
                                        status: "Active",
                                    })
                                    .first();

                            if (!session) {
                                return false;
                            }

                            const previousMeterWh =
                                session.lastMeterWh ?? session.meterStartWh;

                            if (readingWh < previousMeterWh) {
                                console.log(
                                    "Meter value cannot be lower than the previous value",
                                );
                                return false;
                            }

                            await tx.orm.public.MeterReading.create({
                                meterWh: readingWh,
                                recordedAt: readingAt,
                                sessionId: session.transactionId,
                            });

                            await tx.orm.public.ChargingSession.where({
                                transactionId: session.transactionId,
                            }).update({
                                lastMeterWh: readingWh,
                            });

                            await tx.orm.public.Charger.where({
                                id: charger.id,
                            }).update({
                                connected: true,
                                lastSeenAt: now,
                            });

                            return true;
                        });

                        if (!persisted) {
                            console.log(
                                `Could not persist MeterValues for transaction ${transactionId}`,
                            );
                            sendCallError(
                                ws,
                                uniqueId,
                                "GenericError",
                                "Could not persist MeterValues",
                            );
                        } else {
                            console.log(
                                `MeterValues persisted: ${readingWh} Wh for transaction ${transactionId}`,
                            );

                            ws.send(JSON.stringify([3, uniqueId, {}]));
                        }
                    } catch (error) {
                        console.error(
                            `Failed to persist MeterValues for charger ${chargerId}:`,
                            error,
                        );

                        sendCallError(
                            ws,
                            uniqueId,
                            "GenericError",
                            "Could not persist MeterValues",
                        );
                    }

                    return;
                }

                if (action === "StopTransaction") {
                    if (!isJsonObject(payload)) {
                        console.log("Invalid StopTransaction payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "FormationViolation",
                            "StopTransaction payload must be an object",
                        );
                        return;
                    }

                    const stopPayload = payload as {
                        transactionId?: unknown;
                        meterStop?: unknown;
                        timestamp?: unknown;
                        reason?: unknown;
                        idTag?: unknown;
                        transactionData?: unknown;
                    };

                    const transactionId = stopPayload.transactionId;
                    const meterStop = stopPayload.meterStop;
                    const stopAt = parseTimestamp(stopPayload.timestamp);
                    const reason = stopPayload.reason;
                    const idTag = stopPayload.idTag;
                    const transactionData = stopPayload.transactionData;

                    if (
                        !isPositiveInteger(transactionId) ||
                        !isNonNegativeInteger(meterStop) ||
                        stopAt === undefined ||
                        (reason !== undefined && !isStopReason(reason)) ||
                        (idTag !== undefined && !isNonEmptyString(idTag)) ||
                        (transactionData !== undefined &&
                            (!Array.isArray(transactionData) ||
                                !transactionData.every(isJsonObject)))
                    ) {
                        console.log("Invalid StopTransaction payload");
                        sendCallError(
                            ws,
                            uniqueId,
                            "PropertyConstraintViolation",
                            "StopTransaction contains invalid transaction, meter, timestamp, or optional fields",
                        );
                        return;
                    }

                    try {
                        const now = new Date().toISOString();

                        const result = await db.transaction(async (tx) => {
                            const charger = await tx.orm.public.Charger.select(
                                "id",
                                "siteId",
                            )
                                .where({
                                    chargePointId: String(chargerId),
                                })
                                .first();

                            if (!charger) {
                                return {
                                    status: "Invalid" as const,
                                };
                            }

                            const site = await tx.orm.public.Site.select(
                                "tariffPaisePerKwh",
                            )
                                .where({ id: charger.siteId })
                                .first();

                            if (!site || site.tariffPaisePerKwh < 0) {
                                return {
                                    status: "Invalid" as const,
                                };
                            }

                            const session =
                                await tx.orm.public.ChargingSession.select(
                                    "transactionId",
                                    "connectorId",
                                    "status",
                                    "meterStartWh",
                                    "lastMeterWh",
                                )
                                    .where({
                                        transactionId,
                                        chargerId: charger.id,
                                    })
                                    .first();

                            if (!session) {
                                return {
                                    status: "Invalid" as const,
                                };
                            }

                            const previousMeterWh =
                                session.lastMeterWh ?? session.meterStartWh;

                            if (meterStop < previousMeterWh) {
                                return {
                                    status: "Invalid" as const,
                                };
                            }

                            const connector =
                                await tx.orm.public.Connector.select(
                                    "connectorNumber",
                                )
                                    .where({ id: session.connectorId })
                                    .first();

                            if (!connector) {
                                return {
                                    status: "Invalid" as const,
                                };
                            }

                            if (session.status !== "Active") {
                                return {
                                    status: "Accepted" as const,
                                    connectorNumber: connector.connectorNumber,
                                    siteId: charger.siteId,
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

                            await tx.orm.public.MeterReading.create({
                                meterWh: meterStop,
                                recordedAt: stopAt,
                                sessionId: session.transactionId,
                            });

                            await tx.orm.public.ChargingSession.where({
                                transactionId: session.transactionId,
                            }).update({
                                status: "Completed",
                                meterStopWh: meterStop,
                                lastMeterWh: meterStop,
                                stoppedAt: stopAt,
                            });

                            const energyWh = meterStop - session.meterStartWh;
                            const amountPaise = Math.round(
                                (energyWh * site.tariffPaisePerKwh) / 1000,
                            );

                            await tx.orm.public.Invoice.upsert({
                                conflictOn: {
                                    sessionId: session.transactionId,
                                },
                                create: {
                                    sessionId: session.transactionId,
                                    energyWh,
                                    tariffPaisePerKwh: site.tariffPaisePerKwh,
                                    amountPaise,
                                    currency: "INR",
                                    status: "Issued",
                                },
                                update: {
                                    energyWh,
                                    tariffPaisePerKwh: site.tariffPaisePerKwh,
                                    amountPaise,
                                    currency: "INR",
                                    status: "Issued",
                                },
                            });

                            await tx.orm.public.Connector.where({
                                id: session.connectorId,
                            }).update({
                                status: "Available",
                            });

                            await tx.orm.public.Charger.where({
                                id: charger.id,
                            }).update({
                                connected: true,
                                lastSeenAt: now,
                            });

                            return {
                                status: "Accepted" as const,
                                connectorNumber: connector.connectorNumber,
                                siteId: charger.siteId,
                            };
                        });

                        if (
                            result.status === "Accepted" &&
                            result.connectorNumber !== undefined
                        ) {
                            updateConnectorStatus(
                                String(chargerId),
                                result.connectorNumber,
                                "Available",
                                "NoError",
                            );
                        }

                        ws.send(
                            JSON.stringify([
                                3,
                                uniqueId,
                                {
                                    idTagInfo: {
                                        status: result.status,
                                    },
                                },
                            ]),
                        );

                        console.log(
                            `StopTransaction ${result.status.toLowerCase()} for ${chargerId}`,
                        );

                        if (result.status === "Accepted") {
                            void rebalanceSite(result.siteId);
                        }
                    } catch (error) {
                        console.error(
                            `Failed to stop transaction for charger ${chargerId}:`,
                            error,
                        );

                        sendCallError(
                            ws,
                            uniqueId,
                            "GenericError",
                            "Could not persist StopTransaction",
                        );
                    }

                    return;
                }

                sendCallError(
                    ws,
                    uniqueId,
                    "NotSupported",
                    `Action ${action} is not implemented`,
                );
            },

            onClose() {
                unregisterChargerSocket(String(chargerId));
                markChargerDisconnected(String(chargerId));
                void markChargerOffline(String(chargerId));
                console.log(`Charger disconnected: ${chargerId}`);
            },

            onError(error) {
                console.error(`Charger error: ${chargerId}`, error);
            },
        };
    }),
);
