/**
 * The transport, against a real HTTP server (no axios mock): what goes on the
 * wire, what is retried, what comes back.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * T1. A write is retried without an Idempotency-Key, or with a new one on each
 *     attempt — the API runs it twice (the double charge #462 exists to stop).
 * T2. A 4xx is retried (a refused payment hammered), or a 5xx / network error
 *     on a safe call is not.
 * T3. `Retry-After` is ignored on 429 / 409 IDEMPOTENCY_KEY_IN_PROGRESS.
 * T4. The envelope leaks: the caller gets `{ success, data }` instead of `data`,
 *     or an error without the API's `code` / `details`.
 * T5. The API key appears in an error's message or serialisation.
 * T6. The mode is taken from an option instead of the key prefix.
 * T7. A product named by its catalogue id is not resolved to Itaja's id, or a
 *     product the push did not create is guessed instead of refused.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ItajaConnectionError,
  ItajaNotFoundError,
  ItajaServerError,
  ItajaValidationError,
  createItaja,
  creditPack,
  credits,
  type CatalogItem,
} from "../src/index.js";

const KEY = "itjs_test_transport_key_never_printed";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

let server: Server;
let baseUrl = "";
const seen: Seen[] = [];
let script: Reply[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
    const reply = script.shift() ?? { status: 200, body: { success: true, data: {} } };
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
  script = [];
});

const waits: number[] = [];
const client = (catalog?: readonly CatalogItem[]) =>
  createItaja({ apiKey: KEY, baseUrl, catalog, transport: { sleep: async (ms) => void waits.push(ms) } });

describe("transport", () => {
  it("T1 — a write carries one Idempotency-Key, the same on every retry", async () => {
    script = [{ status: 503, body: { success: false, error: "down", code: "UNAVAILABLE" } }, { status: 502 }, { status: 201, body: { success: true, data: { id: "chk_1" } } }];
    const result = await client().checkout.create({ homeUrl: "https://shop.example/back" });
    expect(result).toEqual({ id: "chk_1" });
    const keys = seen.map((s) => s.headers["idempotency-key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("T1 — the caller's own key is used as is", async () => {
    await client().customers.create({ name: "Awa", email: "awa@example.test" }, { idempotencyKey: "order-1042" });
    expect(seen[0]!.headers["idempotency-key"]).toBe("order-1042");
  });

  it("T1 — a credit movement sends the same key in the header and in the body", async () => {
    script = [{ status: 200, body: { success: true, data: { balance: 90 } } }];
    await client().credits.consume({ productId: "prd_1", customerId: "cus_1", amount: 10 }, { idempotencyKey: "use-7" });
    expect(seen[0]!.headers["idempotency-key"]).toBe("use-7");
    expect(JSON.parse(seen[0]!.body)).toEqual({ customerId: "cus_1", amount: 10, idempotencyKey: "use-7" });
  });

  it("T2 — a 4xx is thrown at once, typed, with the API's code and details", async () => {
    script = [{ status: 422, body: { success: false, error: "Catalogue invalid", code: "CATALOG_INVALID", details: { issues: [{ path: "/products/0", message: "x" }] } } }];
    const error = await client().push().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ItajaValidationError);
    expect(error).toMatchObject({ status: 422, code: "CATALOG_INVALID", details: { issues: [{ path: "/products/0", message: "x" }] } });
    expect(seen).toHaveLength(1);
  });

  it("T2 — a 5xx past the retry budget is an ItajaServerError after 3 attempts", async () => {
    script = [{ status: 500 }, { status: 500 }, { status: 500 }];
    await expect(client().customers.get("cus_1")).rejects.toBeInstanceOf(ItajaServerError);
    expect(seen).toHaveLength(3);
  });

  it("T2 — no server at all is an ItajaConnectionError", async () => {
    const offline = createItaja({ apiKey: KEY, baseUrl: "http://127.0.0.1:1/api/v1", maxRetries: 0 });
    await expect(offline.customers.get("cus_1")).rejects.toBeInstanceOf(ItajaConnectionError);
  });

  it("T3 — Retry-After is honoured on 429 and on 409 IDEMPOTENCY_KEY_IN_PROGRESS", async () => {
    waits.length = 0;
    script = [
      { status: 429, headers: { "retry-after": "2" }, body: { success: false, error: "slow", code: "RATE_LIMITED" } },
      { status: 409, headers: { "retry-after": "1" }, body: { success: false, error: "running", code: "IDEMPOTENCY_KEY_IN_PROGRESS" } },
      { status: 201, body: { success: true, data: { id: "chk_2" } } },
    ];
    await client().checkout.create({ homeUrl: "https://shop.example/back" });
    expect(waits).toEqual([2000, 1000]);
  });

  it("T2 — any other 409 is not retried", async () => {
    script = [{ status: 409, body: { success: false, error: "outcome unknown", code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN" } }];
    await expect(client().checkout.create({ homeUrl: "https://shop.example/back" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN" });
    expect(seen).toHaveLength(1);
  });

  it("T4/T5 — headers carry the key and the client tag; no error exposes the key", async () => {
    script = [{ status: 401, body: { success: false, error: "Invalid API key", code: "UNAUTHORIZED" } }];
    const error = await client().customers.get("cus_1").catch((e: unknown) => e);
    expect(seen[0]!.headers["x-itj-key"]).toBe(KEY);
    expect(seen[0]!.headers["x-itaja-client"]).toMatch(/^itaja-node\/\d+\.\d+\.\d+$/);
    expect(seen[0]!.headers["idempotency-key"]).toBeUndefined();
    const dump = JSON.stringify(error) + String(error) + (error as Error).stack;
    expect(dump).not.toContain(KEY);
  });

  it("T6 — the mode is read from the key prefix", () => {
    expect(createItaja({ apiKey: "itjs_x" }).mode).toBe("sandbox");
    expect(createItaja({ apiKey: "itjp_x" }).mode).toBe("live");
  });

  it("T7 — a catalogue id resolves to the product the push created; an unknown one is refused", async () => {
    const tokens = credits({ id: "tokens", name: "Tokens" });
    const itaja = client([creditPack({ id: "small", of: tokens, credits: 10, price: { amount: 100, currency: "XOF" } })]);
    script = [
      { status: 200, body: { success: true, data: [{ id: "prd_dash", catalogKey: null }, { id: "prd_tok", catalogKey: "tokens" }] } },
      { status: 200, body: { success: true, data: { balance: 3 } } },
    ];
    expect(await itaja.credits.balance({ product: "tokens", customerId: "cus_1" })).toEqual({ balance: 3 });
    expect(seen[1]!.url).toBe("/api/v1/products/prd_tok/credits/cus_1/balance");

    script = [{ status: 200, body: { success: true, data: [] } }];
    const error = await itaja.credits.balance({ product: "nope" as "tokens", customerId: "cus_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ItajaNotFoundError);
    expect(error).toMatchObject({ code: "CATALOG_PRODUCT_NOT_PUSHED" });
  });

  it("subscribe / check / report say plainly they are not served yet", async () => {
    await expect(client().subscribe({ customerId: "c", plan: "x" as never })).rejects.toMatchObject({ code: "NOT_YET_AVAILABLE" });
    expect(seen).toHaveLength(0);
  });
});
