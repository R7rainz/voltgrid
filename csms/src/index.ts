import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'

const app = new Hono()

app.get('/', (c) => {
    return c.text('Hello Hono!')
})

app.get('/healthz', (c) => {
    return c.json({
        status: 'ok',
        service: 'voltgrid-csms',
    })
})

app.get(
    '/ocpp/:chargerId',
    upgradeWebSocket((c) => {
        const chargerId = c.req.param('chargerId')

        return {
            onOpen(_event, ws) {
                console.log(`Charger connected: ${chargerId}`)
                ws.send(`Connected to VoltGrid: ${chargerId}`)
            },

            onMessage(event, ws) {
                if (typeof event.data !== 'string') {
                    return
                }

                let message: unknown

                try {
                    message = JSON.parse(event.data)
                } catch {
                    console.log('Invalid JSON received')
                    return
                }

                if (!Array.isArray(message) || message.length < 4) {
                    console.log('Invalid OCPP message')
                    return
                }

                const [messageType, uniqueId, action, payload] = message

                if (
                    messageType !== 2 ||
                    typeof uniqueId !== 'string' ||
                    typeof action !== 'string'
                ) {
                    console.log('Invalid OCPP Call message')
                    return
                }

                console.log(`Received ${action} from ${chargerId}`)

                if (action === 'Heartbeat') {
                    ws.send(
                        JSON.stringify([
                            3,
                            uniqueId,
                            {
                                currentTime: new Date().toISOString(),
                            },
                        ]),
                    )

                    console.log(`Heartbeat received from ${chargerId}`)
                    return
                }

                if (action === 'StatusNotification') {
                    const statusPayload = payload as {
                        connectorId?: number
                        status?: string
                        errorCode?: string
                    }

                    console.log(
                        `Connector ${statusPayload.connectorId} on ${chargerId}: ${statusPayload.status}`,
                    )
                    console.log(`Charger error code: ${statusPayload.errorCode}`)

                    ws.send(
                        JSON.stringify([
                            3,
                            uniqueId,
                            {},
                        ]),
                    )

                    return
                }

                if (action === 'BootNotification') {
                    ws.send(
                        JSON.stringify([
                            3,
                            uniqueId,
                            {
                                status: 'Accepted',
                                currentTime: new Date().toISOString(),
                                interval: 300,
                            },
                        ]),
                    )

                    console.log(`BootNotification accepted for ${chargerId}`)
                    return
                }

                ws.send(
                    JSON.stringify([
                        4,
                        uniqueId,
                        'NotImplemented',
                        `Action ${action} is not implemented`,
                        {},
                    ]),
                )
            },

            onClose() {
                console.log(`Charger disconnected: ${chargerId}`)
            },

            onError(error) {
                console.error(`Charger error: ${chargerId}`, error)
            },
        }
    }),
)

const port = Number(Bun.env.PORT ?? 8080)

export { app }
export default {
    port,
    fetch: app.fetch,
    websocket,
}
