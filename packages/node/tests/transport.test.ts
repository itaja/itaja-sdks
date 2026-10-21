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
 * T7. A product referenced by its name is not resolved to Itaja's id (the
 *     product's `catalogKey`, the normalised name), a spelling that differs
 *     only by case or spaces misses it, or a product the push did not create
 *     is guessed instead of refused. Same for a credit pack's name.
 * T8. The return URLs never reach the API: `credits.buy` rebuilds its body from
 *     a fixed list of fields, so one missing from it is silently dropped and the
 *     payer stays on Itaja's return page.
 * T9. An outcome borrows another's address: two fields swapped on the way, or an
 *     omitted one sent as `null` / `""` (the API refuses an empty URL with 422).
 * T10. The generated types lag the spec and `checkout.create` refuses the fields
 *     at compile time (caught by `pnpm generate:check` and `pnpm typecheck`; the
 *     calls below are typed, with no cast).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ItajaConfigError,
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
    script = [
      { status: 200, body: { success: true, data: [{ id: "prd_1", catalogKey: "ai tokens" }] } },
      { status: 200, body: { success: true, data: { balance: 90 } } },
    ];
    await client().credits.consume({ product: "AI tokens", customerId: "cus_1", amount: 10 }, { idempotencyKey: "use-7" });
    expect(seen[1]!.url).toBe("/api/v1/products/prd_1/credits/consume");
    expect(seen[1]!.headers["idempotency-key"]).toBe("use-7");
    expect(JSON.parse(seen[1]!.body)).toEqual({ customerId: "cus_1", amount: 10, idempotencyKey: "use-7" });
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

  it("T7 — a product name resolves, normalised, to the product the push created; an unknown one is refused", async () => {
    const tokens = credits({ name: "AI tokens" });
    const itaja = client([creditPack({ name: "10 tokens", of: tokens, credits: 10, price: { amount: 100, currency: "XOF" } })]);
    script = [
      { status: 200, body: { success: true, data: [{ id: "prd_dash", catalogKey: null }, { id: "prd_tok", catalogKey: "ai tokens" }] } },
      { status: 200, body: { success: true, data: { balance: 3 } } },
    ];
    expect(await itaja.credits.balance({ product: "AI tokens", customerId: "cus_1" })).toEqual({ balance: 3 });
    expect(seen[0]!.url).toBe("/api/v1/products");
    expect(seen[1]!.url).toBe("/api/v1/products/prd_tok/credits/cus_1/balance");

    // Another spelling of the same name: resolved from the cached list, no new read.
    script = [{ status: 200, body: { success: true, data: { balance: 4 } } }];
    expect(await itaja.credits.balance({ product: "  ai   TOKENS ", customerId: "cus_1" })).toEqual({ balance: 4 });
    expect(seen[2]!.url).toBe("/api/v1/products/prd_tok/credits/cus_1/balance");

    script = [{ status: 200, body: { success: true, data: [] } }];
    const error = await itaja.credits.balance({ product: "Nope", customerId: "cus_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ItajaNotFoundError);
    expect(error).toMatchObject({ code: "CATALOG_PRODUCT_NOT_PUSHED" });
    expect((error as Error).message).toContain('No product named "Nope"');
  });

  it("T7 — a product reference takes a name only: productId is not part of the surface", async () => {
    const itaja = client();
    // @ts-expect-error products are referenced by name, never by id
    const error = await itaja.credits.balance({ productId: "prd_tok", customerId: "cus_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ItajaConfigError);
    expect(error).toMatchObject({ code: "PRODUCT_NAME_MISSING" });
    expect(seen).toHaveLength(0);
  });

  it("T7 — a licence is issued against its product name; the name never reaches the body", async () => {
    script = [
      { status: 200, body: { success: true, data: [{ id: "prd_lic", catalogKey: "desktop app" }] } },
      { status: 201, body: { success: true, data: { keyId: "key_1" } } },
    ];
    await client().licenses.issue({ product: "Desktop App", customerId: "cus_1" });
    expect(seen[1]!.url).toBe("/api/v1/products/prd_lic/licenses");
    expect(JSON.parse(seen[1]!.body)).toEqual({ customerId: "cus_1" });
  });

  it("T7 — credits.buy resolves the pack by its normalised name; an unknown pack is refused", async () => {
    const products = { status: 200, body: { success: true, data: [{ id: "prd_tok", catalogKey: "ai tokens" }] } };
    const packs = { status: 200, body: { success: true, data: { packs: [{ id: "pck_other", catalogKey: "500 tokens" }, { id: "pck_100", catalogKey: "100 tokens" }] } } };
    script = [products, packs, { status: 201, body: { success: true, data: { checkoutUrl: "https://pay.example/c/9" } } }];
    const itaja = client();
    await itaja.credits.buy({ product: "AI tokens", pack: " 100  TOKENS", customerId: "cus_1", homeUrl: "https://shop.example/back" });
    expect(seen[2]!.url).toBe("/api/v1/products/prd_tok/credit-packs/pck_100/checkout");

    script = [packs];
    const error = await itaja.credits.buy({ product: "AI tokens", pack: "pck_100", customerId: "cus_1", homeUrl: "https://shop.example/back" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ItajaNotFoundError);
    expect(error).toMatchObject({ code: "CREDIT_PACK_NOT_FOUND" });
    expect((error as Error).message).toContain('No credit pack named "pck_100"');
  });

  it("T8/T9 — checkout.create sends each return URL under its own name", async () => {
    script = [{ status: 201, body: { success: true, data: { id: "chk_3" } } }];
    await client().checkout.create({
      homeUrl: "https://shop.example/back",
      successUrl: "https://shop.example/paid?order=1042#top",
      failureUrl: "https://shop.example/failed",
      cancelUrl: "https://shop.example/cart",
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({
      homeUrl: "https://shop.example/back",
      successUrl: "https://shop.example/paid?order=1042#top",
      failureUrl: "https://shop.example/failed",
      cancelUrl: "https://shop.example/cart",
    });
  });

  it("T8/T9 — credits.buy forwards the return URLs to the pack checkout", async () => {
    script = [
      { status: 200, body: { success: true, data: [{ id: "prd_tok", catalogKey: "ai tokens" }] } },
      { status: 200, body: { success: true, data: { packs: [{ id: "pck_small", catalogKey: "100 tokens" }] } } },
      { status: 201, body: { success: true, data: { checkoutUrl: "https://pay.example/c/1" } } },
    ];
    await client().credits.buy({
      product: "AI tokens",
      pack: "100 tokens",
      customerId: "cus_1",
      homeUrl: "https://shop.example/back",
      successUrl: "https://shop.example/paid",
      failureUrl: "https://shop.example/failed",
      cancelUrl: "https://shop.example/cart",
    });
    expect(seen[2]!.url).toBe("/api/v1/products/prd_tok/credit-packs/pck_small/checkout");
    expect(JSON.parse(seen[2]!.body)).toEqual({
      customerId: "cus_1",
      homeUrl: "https://shop.example/back",
      successUrl: "https://shop.example/paid",
      failureUrl: "https://shop.example/failed",
      cancelUrl: "https://shop.example/cart",
    });
  });

  it("T9 — an omitted return URL is absent from the body, never null or empty", async () => {
    script = [
      { status: 200, body: { success: true, data: [{ id: "prd_tok", catalogKey: "ai tokens" }] } },
      { status: 200, body: { success: true, data: { packs: [{ id: "pck_small", catalogKey: "100 tokens" }] } } },
      { status: 201, body: { success: true, data: { checkoutUrl: "https://pay.example/c/2" } } },
    ];
    await client().credits.buy({ product: "AI tokens", pack: "100 tokens", customerId: "cus_1", homeUrl: "https://shop.example/back", successUrl: "https://shop.example/paid" });
    const body = JSON.parse(seen[2]!.body) as Record<string, unknown>;
    expect(body).toEqual({ customerId: "cus_1", homeUrl: "https://shop.example/back", successUrl: "https://shop.example/paid" });
    expect(Object.keys(body)).not.toContain("cancelUrl");
    expect(Object.keys(body)).not.toContain("failureUrl");
  });

  it("subscribe / check / report say plainly they are not served yet", async () => {
    await expect(client().subscribe({ customerId: "c", plan: "Pro", product: "My App" })).rejects.toMatchObject({ code: "NOT_YET_AVAILABLE" });
    expect(seen).toHaveLength(0);
  });
});
