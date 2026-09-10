import { websocket } from "hono/bun";
import { app } from "./app";

const port = Number(Bun.env.PORT ?? 8080);

export { app };
export default {
  port,
  fetch: app.fetch,
  websocket,
};
