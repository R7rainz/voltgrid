import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type BunServer = ReturnType<typeof Bun.serve>;
type Database = (typeof import("../src/infrastructure/database/db"))["db"];
type OcppFrame = [number, string, ...unknown[]];

const databaseAvailable = Boolean(process.env.DATABASE_URL);

if (process.env.REQUIRE_PHASE1_DATABASE === "1" && !databaseAvailable) {
    throw new Error("DATABASE_URL is required for the Phase 1 integration suite");
}

const phase1 = databaseAvailable ? describe : describe.skip;

class OcppClient {
    private requestNumber = 0;
    private readonly pending = new Map<
        string,
        {
            resolve: (frame: OcppFrame) => void;
            reject: (error: Error) => void;
            timeout: ReturnType<typeof setTimeout>;
        }
    >();

    private constructor(private readonly socket: WebSocket) {
        socket.onmessage = (event) => {
            if (typeof event.data !== "string") {
                return;
            }

            const frame = JSON.parse(event.data) as OcppFrame;
            if (frame[0] === 2 && frame[2] === "SetChargingProfile") {
                this.socket.send(JSON.stringify([3, frame[1], { status: "Accepted" }]));
                return;
            }
            const request = this.pending.get(frame[1]);

            if (!request) {
                return;
            }

            clearTimeout(request.timeout);
            this.pending.delete(frame[1]);
            request.resolve(frame);
        };

        socket.onclose = () => {
            for (const request of this.pending.values()) {
                clearTimeout(request.timeout);
                request.reject(new Error("WebSocket closed before the CSMS replied"));
            }

            this.pending.clear();
        };
    }

    static async connect(url: string) {
        const socket = new WebSocket(url);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error(`Timed out connecting to ${url}`)),
                3_000,
            );

            socket.onopen = () => {
                clearTimeout(timeout);
                resolve();
            };
            socket.onerror = () => {
                clearTimeout(timeout);
                reject(new Error(`Could not connect to ${url}`));
            };
        });

        return new OcppClient(socket);
    }

    call(
        action: string,
        payload: Record<string, unknown>,
        uniqueId = `test-${++this.requestNumber}`,
    ) {
        return this.send([2, uniqueId, action, payload], uniqueId);
    }

    send(frame: unknown[], uniqueId: string) {
        return new Promise<OcppFrame>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(uniqueId);
                reject(new Error(`Timed out waiting for OCPP response ${uniqueId}`));
            }, 3_000);

            this.pending.set(uniqueId, { resolve, reject, timeout });
            this.socket.send(JSON.stringify(frame));
        });
    }

    async close() {
        if (this.socket.readyState === WebSocket.CLOSED) {
            return;
        }

        await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 1_000);

            this.socket.addEventListener(
                "close",
                () => {
                    clearTimeout(timeout);
                    resolve();
                },
                { once: true },
            );
            this.socket.close();
        });
    }
}

phase1("CSMS end-to-end", () => {
    let csms: BunServer;
    let allocator: BunServer | undefined;
    let db: Database;
    let httpUrl: string;
    let websocketUrl: string;

    beforeAll(async () => {
        if (process.env.PHASE2_REAL_ALLOCATOR !== "1") allocator = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const input = (await request.json()) as {
                    sitePowerLimitKw: number;
                    activeChargers: Array<{
                        chargerId: string;
                        requestedPowerKw: number;
                        maxPowerKw: number;
                    }>;
                };
                const share = input.activeChargers.length
                    ? input.sitePowerLimitKw / input.activeChargers.length
                    : 0;
                const allocations = input.activeChargers.map((charger) => ({
                    chargerId: charger.chargerId,
                    allocatedPowerKw: Math.min(
                        share,
                        charger.requestedPowerKw,
                        charger.maxPowerKw,
                    ),
                }));

                return Response.json({
                    sitePowerLimitKw: input.sitePowerLimitKw,
                    totalAllocatedPowerKw: allocations.reduce(
                        (total, allocation) =>
                            total + allocation.allocatedPowerKw,
                        0,
                    ),
                    allocations,
                });
            },
        });

        if (allocator) process.env.LOAD_BALANCER_URL = `http://127.0.0.1:${allocator.port}`;
        else if (!process.env.LOAD_BALANCER_URL) throw new Error("LOAD_BALANCER_URL is required for the real Go integration test");
        process.env.CHARGER_MAX_POWER_KW = "50";

        const [{ app }, { websocket }, database] = await Promise.all([
            import("../src/app"),
            import("hono/bun"),
            import("../src/infrastructure/database/db"),
        ]);

        db = database.db;

        const site = await db.orm.public.Site.select("id").first();

        if (site) {
            await db.orm.public.Site.where({ id: site.id }).update({
                name: "VoltGrid Phase 1 Test Site",
                powerLimitKw: 100,
                tariffPaisePerKwh: 800,
            });
        } else {
            await db.orm.public.Site.create({
                name: "VoltGrid Phase 1 Test Site",
                powerLimitKw: 100,
                tariffPaisePerKwh: 800,
            });
        }

        csms = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: app.fetch,
            websocket,
        });
        httpUrl = `http://127.0.0.1:${csms.port}`;
        websocketUrl = `ws://127.0.0.1:${csms.port}`;
    });

    afterAll(async () => {
        await csms?.stop(true);
        await allocator?.stop(true);
        await db?.close();
    });

    test("serves health and database-backed station settings", async () => {
        const health = await fetch(`${httpUrl}/healthz`);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({
            status: "ok",
            service: "voltgrid-csms",
        });

        const update = await fetch(`${httpUrl}/api/site`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                powerLimitKw: 125.5,
                tariffPaisePerKwh: 975,
            }),
        });
        expect(update.status).toBe(200);
        expect(await update.json()).toMatchObject({
            site: {
                powerLimitKw: 125.5,
                tariffPaisePerKwh: 975,
            },
        });

        const site = await db.orm.public.Site.select("id").first();
        expect(site).toBeDefined();
        await db.orm.public.Site.where({ id: site!.id }).update({
            powerLimitKw: 100,
            tariffPaisePerKwh: 800,
        });
    });

    test("returns OCPP errors for malformed, invalid, and unsupported calls", async () => {
        const client = await OcppClient.connect(
            `${websocketUrl}/ocpp/validation-${crypto.randomUUID()}`,
        );

        const malformedId = `malformed-${crypto.randomUUID()}`;
        const malformed = await client.send(
            [2, malformedId, "Heartbeat"],
            malformedId,
        );
        expect(malformed.slice(0, 3)).toEqual([
            4,
            malformedId,
            "ProtocolError",
        ]);

        const invalidBoot = await client.call("BootNotification", {
            chargePointVendor: "",
            chargePointModel: "Demo",
        });
        expect(invalidBoot[0]).toBe(4);
        expect(invalidBoot[2]).toBe("PropertyConstraintViolation");

        const unsupported = await client.call("Reset", {});
        expect(unsupported[0]).toBe(4);
        expect(unsupported[2]).toBe("NotSupported");

        await client.close();
    });

    test("allows request IDs to restart after a charger reconnects", async () => {
        const chargerId = `reconnect-${crypto.randomUUID()}`;
        const url = `${websocketUrl}/ocpp/${chargerId}`;
        const first = await OcppClient.connect(url);

        await first.call(
            "BootNotification",
            {
                chargePointVendor: "VoltGrid Tests",
                chargePointModel: "Reconnect Charger",
            },
            "reused-1",
        );

        for (const uniqueId of ["reused-2", "reused-3", "reused-4"]) {
            await first.call(
                "StatusNotification",
                {
                    connectorId: 1,
                    status: "Available",
                    errorCode: "NoError",
                },
                uniqueId,
            );
        }

        await first.close();

        const second = await OcppClient.connect(url);
        await second.call(
            "BootNotification",
            {
                chargePointVendor: "VoltGrid Tests",
                chargePointModel: "Reconnect Charger",
            },
            "reused-1",
        );
        await second.call(
            "StatusNotification",
            {
                connectorId: 1,
                status: "Available",
                errorCode: "NoError",
            },
            "reused-2",
        );

        const start = await second.call(
            "StartTransaction",
            {
                connectorId: 1,
                idTag: `driver-${crypto.randomUUID()}`,
                meterStart: 100_000,
                timestamp: new Date().toISOString(),
            },
            "reused-3",
        );
        const transactionId = (start[2] as { transactionId: number })
            .transactionId;
        if (!Number.isInteger(transactionId) || transactionId < 1) {
            throw new Error(
                `Invalid transaction response: ${JSON.stringify(start)}`,
            );
        }
        expect(start[2]).toMatchObject({
            transactionId,
            idTagInfo: { status: "Accepted" },
        });
        expect(
            await second.call(
                "MeterValues",
                {
                    connectorId: 1,
                    transactionId,
                    meterValue: [
                        {
                            timestamp: new Date().toISOString(),
                            sampledValue: [
                                {
                                    value: "101000",
                                    measurand: "Energy.Active.Import.Register",
                                    unit: "Wh",
                                },
                            ],
                        },
                    ],
                },
                "reused-4",
            ),
        ).toEqual([3, "reused-4", {}]);

        const stop = await second.call("StopTransaction", {
            transactionId,
            meterStop: 101_000,
            timestamp: new Date().toISOString(),
            reason: "Local",
        });
        expect(stop[2]).toEqual({ idTagInfo: { status: "Accepted" } });

        await second.close();
    });

    test("persists one idempotent session, meter reading, and invoice", async () => {
        const chargerId = `phase1-${crypto.randomUUID()}`;
        const idTag = `driver-${crypto.randomUUID()}`;
        const client = await OcppClient.connect(
            `${websocketUrl}/ocpp/${chargerId}`,
        );

        const boot = await client.call("BootNotification", {
            chargePointVendor: "VoltGrid Tests",
            chargePointModel: "Phase 1 Charger",
        });
        expect(boot[0]).toBe(3);
        expect(boot[2]).toMatchObject({ status: "Accepted", interval: 300 });

        const status = await client.call("StatusNotification", {
            connectorId: 1,
            status: "Available",
            errorCode: "NoError",
        });
        expect(status).toEqual([3, status[1], {}]);

        const heartbeat = await client.call("Heartbeat", {});
        expect(heartbeat[0]).toBe(3);
        expect(heartbeat[2]).toMatchObject({
            currentTime: expect.any(String),
        });

        const startId = `start-${crypto.randomUUID()}`;
        const startPayload = {
            connectorId: 1,
            idTag,
            meterStart: 100_000,
            timestamp: new Date().toISOString(),
        };
        const start = await client.call(
            "StartTransaction",
            startPayload,
            startId,
        );
        const repeatedStart = await client.call(
            "StartTransaction",
            startPayload,
            startId,
        );
        const transactionId = (
            start[2] as { transactionId: number }
        ).transactionId;

        expect(start[2]).toMatchObject({
            transactionId: expect.any(Number),
            meterWh: 100_000,
            idTagInfo: { status: "Accepted" },
        });
        expect(repeatedStart[2]).toEqual(start[2]);

        const sessions = await db.orm.public.ChargingSession.select(
            "transactionId",
        )
            .where({ idTag })
            .all();
        expect(sessions).toHaveLength(1);

        const meterId = `meter-${crypto.randomUUID()}`;
        const meterPayload = {
            connectorId: 1,
            transactionId,
            meterValue: [
                {
                    timestamp: new Date().toISOString(),
                    sampledValue: [
                        {
                            value: "102500",
                            measurand: "Energy.Active.Import.Register",
                            unit: "Wh",
                        },
                    ],
                },
            ],
        };

        expect(await client.call("MeterValues", meterPayload, meterId)).toEqual([
            3,
            meterId,
            {},
        ]);
        expect(await client.call("MeterValues", meterPayload, meterId)).toEqual([
            3,
            meterId,
            {},
        ]);

        const readings = await db.orm.public.MeterReading.select("id")
            .where({ sessionId: transactionId })
            .all();
        expect(readings).toHaveLength(1);

        const resumedStart = await client.call("StartTransaction", {
            ...startPayload,
            timestamp: new Date().toISOString(),
        });
        expect(resumedStart[2]).toMatchObject({
            transactionId,
            meterWh: 102_500,
            idTagInfo: { status: "ConcurrentTx" },
        });

        const stopId = `stop-${crypto.randomUUID()}`;
        const stopPayload = {
            transactionId,
            meterStop: 102_500,
            timestamp: new Date().toISOString(),
            reason: "Local",
        };
        const stop = await client.call("StopTransaction", stopPayload, stopId);
        const repeatedStop = await client.call(
            "StopTransaction",
            stopPayload,
            stopId,
        );

        expect(stop[2]).toEqual({ idTagInfo: { status: "Accepted" } });
        expect(repeatedStop[2]).toEqual(stop[2]);

        const invoiceResponse = await fetch(
            `${httpUrl}/api/sessions/${transactionId}/invoice`,
        );
        expect(invoiceResponse.status).toBe(200);
        expect(await invoiceResponse.json()).toMatchObject({
            invoice: {
                sessionId: transactionId,
                energyWh: 2_500,
                tariffPaisePerKwh: 800,
                amountPaise: 2_000,
                currency: "INR",
                status: "Issued",
                energyKwh: 2.5,
                amountInr: "20.00",
            },
        });

        const invoices = await db.orm.public.Invoice.select("id")
            .where({ sessionId: transactionId })
            .all();
        expect(invoices).toHaveLength(1);

        const chargersResponse = await fetch(`${httpUrl}/api/chargers`);
        const chargers = (await chargersResponse.json()) as {
            chargers: Array<{ chargerId: string; connected: boolean }>;
        };
        expect(chargers.chargers).toContainEqual(
            expect.objectContaining({ chargerId, connected: true }),
        );

        await client.close();
    });

    test("runs four complete charger sessions concurrently", async () => {
        const runSimulator = async (number: number) => {
            const chargerId = `cli-${number}-${crypto.randomUUID()}`;
            const child = Bun.spawn(
                [process.execPath, "run", "scripts/simulate-charger.ts"],
                {
                    cwd: new URL("../", import.meta.url).pathname,
                    env: {
                        ...Bun.env,
                        PORT: String(csms.port),
                        CHARGER_ID: chargerId,
                        ID_TAG: `CLI-DRIVER-${number}`,
                        SIMULATOR_TIMEOUT_MS: "5000",
                    },
                    stdout: "pipe",
                    stderr: "pipe",
                },
            );
            const [exitCode, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);

            return { chargerId, exitCode, stdout, stderr };
        };

        const results = await Promise.all(
            [1, 2, 3, 4].map(runSimulator),
        );

        for (const result of results) {
            if (result.exitCode !== 0) {
                throw new Error(result.stderr || result.stdout);
            }

            expect(result.stdout).toContain("completed");
            expect(result.stdout).toContain('"amountInr":"20.00"');
        }

        const response = await fetch(`${httpUrl}/api/chargers`);
        const body = (await response.json()) as {
            chargers: Array<{ chargerId: string }>;
        };

        for (const result of results) {
            expect(body.chargers).toContainEqual(
                expect.objectContaining({ chargerId: result.chargerId }),
            );
        }
    });

    test("rebalances three chargers, isolates a fault, and resumes without phantom energy", async () => {
        const clients: OcppClient[] = [];
        const ids: string[] = [];
        const transactions: number[] = [];
        try {
            for (let index = 0; index < 3; index += 1) {
                const chargerId = `balance-${crypto.randomUUID()}`;
                ids.push(chargerId);
                const client = await OcppClient.connect(`${websocketUrl}/ocpp/${chargerId}`);
                clients.push(client);
                await client.call("BootNotification", {
                    chargePointVendor: "VoltGrid Tests",
                    chargePointModel: "Balancing Charger",
                });
                await client.call("StatusNotification", {
                    connectorId: 1, status: "Available", errorCode: "NoError",
                });
                expect((await client.call("DataTransfer", {
                    vendorId: "VoltGrid",
                    messageId: "PowerRequest",
                    data: JSON.stringify({ requestedPowerKw: 40 }),
                }))[2]).toEqual({ status: "Accepted" });
                const start = await client.call("StartTransaction", {
                    connectorId: 1,
                    idTag: `BALANCE-${index}-${crypto.randomUUID()}`,
                    meterStart: 100_000,
                    timestamp: new Date().toISOString(),
                });
                transactions.push((start[2] as { transactionId: number }).transactionId);
            }

            const allocations = async () => {
                const response = await fetch(`${httpUrl}/api/chargers`);
                const body = await response.json() as {
                    chargers: Array<{ chargerId: string; allocatedPowerKw: number }>;
                };
                return ids.map((id) => body.chargers.find((charger) => charger.chargerId === id)?.allocatedPowerKw ?? 0);
            };
            const waitFor = async (expected: number[]) => {
                for (let attempt = 0; attempt < 100; attempt += 1) {
                    const actual = await allocations();
                    if (actual.every((power, index) => Math.abs(power - expected[index]) < 0.01)) return actual;
                    await Bun.sleep(50);
                }
                throw new Error(`Timed out waiting for ${expected}; got ${await allocations()}`);
            };

            const initial = await waitFor([33.333, 33.333, 33.333]);
            expect(initial.reduce((sum, power) => sum + power, 0)).toBeLessThanOrEqual(100);

            const updateSite = async (powerLimitKw: number) => {
                const response = await fetch(`${httpUrl}/api/site`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ powerLimitKw, tariffPaisePerKwh: 800 }),
                });
                expect(response.status).toBe(200);
            };
            await updateSite(60);
            const reduced = await waitFor([20, 20, 20]);
            expect(reduced.reduce((sum, power) => sum + power, 0)).toBeLessThanOrEqual(60);
            await updateSite(100);
            await waitFor([33.333, 33.333, 33.333]);

            await clients[0].call("DataTransfer", {
                vendorId: "VoltGrid",
                messageId: "PowerRequest",
                data: JSON.stringify({ requestedPowerKw: 20 }),
            });
            await waitFor(process.env.PHASE2_REAL_ALLOCATOR === "1"
                ? [20, 40, 40] : [20, 33.333, 33.333]);
            await clients[0].call("DataTransfer", {
                vendorId: "VoltGrid",
                messageId: "PowerRequest",
                data: JSON.stringify({ requestedPowerKw: 40 }),
            });
            await waitFor([33.333, 33.333, 33.333]);

            expect((await clients[2].call("StatusNotification", {
                connectorId: 1, status: "Faulted", errorCode: "PowerSwitchFailure",
            }))[0]).toBe(3);
            await waitFor(process.env.PHASE2_REAL_ALLOCATOR === "1"
                ? [40, 40, 0] : [33.333, 33.333, 0]);

            const badReading = await clients[2].call("MeterValues", {
                connectorId: 1,
                transactionId: transactions[2],
                meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [
                    { value: "101000", unit: "Wh", measurand: "Energy.Active.Import.Register" },
                ] }],
            });
            expect(badReading[0]).toBe(4);
            const faultedSession = await db.orm.public.ChargingSession
                .select("lastMeterWh").where({ transactionId: transactions[2] }).first();
            expect(faultedSession?.lastMeterWh).toBe(100_000);
            expect((await clients[2].call("StopTransaction", {
                transactionId: transactions[2], meterStop: 101_000,
                timestamp: new Date().toISOString(), reason: "Local",
            }))[2]).toMatchObject({ idTagInfo: { status: "Invalid" } });
            expect((await db.orm.public.ChargingSession.select("status")
                .where({ transactionId: transactions[2] }).first())?.status).toBe("Active");

            expect((await clients[2].call("StatusNotification", {
                connectorId: 1, status: "Charging", errorCode: "NoError",
            }))[0]).toBe(3);
            await waitFor([33.333, 33.333, 33.333]);

            let events: Array<{ kind: string; text: string }> = [];
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const response = await fetch(`${httpUrl}/api/chargers/${ids[2]}/black-box`);
                events = (await response.json() as { events: typeof events }).events;
                if (events.some((event) => event.kind === "recovery") &&
                    events.some((event) => event.kind === "profile" && event.text.includes("0 kW")) &&
                    events.some((event) => event.kind === "profile" && event.text.includes("33.333 kW"))) break;
                await Bun.sleep(50);
            }
            expect(events.map((event) => event.kind)).toContain("fault");
            expect(events.some((event) => event.text.includes("0 kW"))).toBe(true);
            expect(events.some((event) => event.kind === "recovery")).toBe(true);
            expect(events.findIndex((event) => event.kind === "fault"))
                .toBeLessThan(events.findIndex((event) => event.text.includes("0 kW")));
            expect(events.findIndex((event) => event.text.includes("0 kW")))
                .toBeLessThan(events.findIndex((event) => event.kind === "recovery"));

            await clients[2].call("StopTransaction", {
                transactionId: transactions[2], meterStop: 100_000,
                timestamp: new Date().toISOString(), reason: "Local",
            });
            const invoice = await fetch(`${httpUrl}/api/sessions/${transactions[2]}/invoice`);
            expect((await invoice.json() as { invoice: { energyWh: number } }).invoice.energyWh).toBe(0);
            await waitFor([40, 40, 0]);
        } finally {
            await Promise.all(clients.map((client) => client.close()));
        }
    }, 30_000);
});
