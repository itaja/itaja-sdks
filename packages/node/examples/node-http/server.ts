/**
 * 3. Mount — one route on a plain `node:http` server. With Express:
 *    app.post("/itaja/webhook", express.raw({ type: "*\/*" }), itaja.nodeHandler)
 * With Next.js (app router), Hono, Bun or Elysia: `itaja.handler` takes a Request.
 */
import { createServer } from "node:http";
import { itaja } from "./itaja.config.js";

const port = Number(process.env.PORT ?? 4242);
createServer((req, res) => {
  if (req.url === "/itaja/webhook") return void itaja.nodeHandler(req, res);
  res.statusCode = 404;
  res.end();
}).listen(port, () => console.log(`[shop] listening on http://127.0.0.1:${port}/itaja/webhook`));
