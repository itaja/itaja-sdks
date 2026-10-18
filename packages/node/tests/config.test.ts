/**
 * Where createItaja reads its key, webhook secret and API URL.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * E1. An option passed to createItaja is ignored when the environment variable
 *     is also set (a test or a multi-tenant server cannot pick its key).
 * E2. With no option, ITAJA_API_KEY / ITAJA_WEBHOOK_SECRET / ITAJA_API_URL are
 *     not read, so a deployed app that only sets the environment fails.
 * E3. The base URL is not the one the requests go to (a sandbox or staging API
 *     cannot be targeted), or a trailing slash breaks the paths.
 * E4. A missing key or secret fails silently instead of naming the variable, or a
 *     missing key throws synchronously out of a call that returns a promise (an
 *     `await itaja.x().catch()` would not catch it).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ItajaConfigError, createItaja, signPayload } from "../src/index.js";

let server: Server;
let url = "";
const seen: Array<{ path: string; key: string | undefined }> = [];
const saved = { ...process.env };

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", key: req.headers["x-itj-key"] as string | undefined });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, data: { ok: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  seen.length = 0;
  for (const name of ["ITAJA_API_KEY", "ITAJA_WEBHOOK_SECRET", "ITAJA_API_URL"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const delivery = (secret: string) => {
  const body = JSON.stringify({ id: "itaja_evt_cfg", type: "checkout.paid", mode: "sandbox", data: {} });
  return new Request("http://app.test/itaja/webhook", { method: "POST", headers: signPayload({ payload: body, secret }), body });
};

describe("createItaja configuration", () => {
  it("E2 — reads the key, the secret and the API URL from the environment", async () => {
    process.env.ITAJA_API_KEY = "itjs_from_env";
    process.env.ITAJA_WEBHOOK_SECRET = "whsec_from_env";
    process.env.ITAJA_API_URL = `${url}/`;
    const itaja = createItaja();

    expect(itaja.mode).toBe("sandbox");
    await itaja.request("GET", "/me");
    expect(seen).toEqual([{ path: "/api/v1/me", key: "itjs_from_env" }]);
    expect((await itaja.handler(delivery("whsec_from_env"))).status).toBe(200);
  });

  it("E1 / E3 — explicit options win over the environment", async () => {
    process.env.ITAJA_API_KEY = "itjs_from_env";
    process.env.ITAJA_WEBHOOK_SECRET = "whsec_from_env";
    process.env.ITAJA_API_URL = "http://127.0.0.1:1/never";
    const itaja = createItaja({ apiKey: "itjp_explicit", webhookSecret: "whsec_explicit", baseUrl: url });

    expect(itaja.mode).toBe("live");
    await itaja.request("GET", "/me");
    expect(seen).toEqual([{ path: "/api/v1/me", key: "itjp_explicit" }]);
    expect((await itaja.handler(delivery("whsec_from_env"))).status).toBe(400);
  });

  it("E4 — a missing key or secret names the variable to set", async () => {
    delete process.env.ITAJA_API_KEY;
    delete process.env.ITAJA_WEBHOOK_SECRET;
    const itaja = createItaja({ baseUrl: url });

    await expect(itaja.request("GET", "/me")).rejects.toThrow(/ITAJA_API_KEY/);
    await expect(itaja.customers.get("cus_1")).rejects.toThrow(ItajaConfigError);
    await expect(itaja.push({ dryRun: true })).rejects.toThrow(/ITAJA_API_KEY/);
    expect(() => itaja.handler(delivery("x"))).toThrow(ItajaConfigError);
    expect(() => itaja.handler(delivery("x"))).toThrow(/ITAJA_WEBHOOK_SECRET/);
    expect(seen).toEqual([]);
  });
});
