/**
 * Webhook verification and the mounted handler (ADR 0015 D6).
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * W1. A signature Itaja's backend produced is refused (the two sides disagree
 *     on the signed content, the encoding or the header format).
 * W2. A tampered body, a body re-serialised by a JSON parser, or a signature
 *     made with another secret is accepted.
 * W3. A delivery older (or newer) than the tolerance is accepted — a captured
 *     request replays forever.
 * W4. A missing header, a non-numeric timestamp, or another scheme than `v1`
 *     throws something else than ItajaSignatureError (a 500 instead of a 400).
 * W5. During a secret rotation (`v1,<old>,<new>`), the delivery is refused.
 * W6. The same event id delivered twice runs the handlers twice.
 * W7. A handler that throws is acknowledged (200) or marked processed: Itaja
 *     never redelivers and the event is lost.
 * W8. A sandbox event reaches a live key's handlers (or the reverse).
 * W9. An event type the SDK does not know throws instead of reaching "*".
 * W10. The Node adapter loses the raw body (signature fails), or silently
 *      accepts a body Express already parsed.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import {
  ItajaSignatureError,
  constructEvent,
  createWebhookHandler,
  memoryDedupeStore,
  signPayload,
  toNodeHandler,
  type AnyItajaEvent,
} from "../src/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../../spec/signature-vectors.json", import.meta.url), "utf8")) as {
  secret: string;
  vectors: Array<{ name: string; timestamp: string; body: string; signature: string }>;
};
const SECRET = vectors.secret;
const first = vectors.vectors[0]!;
const at = (v: { timestamp: string }) => Number(v.timestamp);
const headersOf = (v: { timestamp: string; signature: string }) => ({
  "x-itaja-signature": v.signature,
  "x-itaja-timestamp": v.timestamp,
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ItajaSignatureError);
    return (error as ItajaSignatureError).code;
  }
  return "ACCEPTED";
}

describe("constructEvent", () => {
  it.each(vectors.vectors)("W1 — accepts the backend's own signature: $name", (v) => {
    const event = constructEvent({ payload: v.body, headers: headersOf(v), secret: SECRET, now: at(v) });
    expect(event.id).toBe(JSON.parse(v.body).id);
  });

  it("W1 — reads the headers from a Headers object, in any casing", () => {
    const h = new Headers({ "X-Itaja-Signature": first.signature, "X-ITAJA-TIMESTAMP": first.timestamp });
    expect(constructEvent({ payload: first.body, headers: h, secret: SECRET, now: at(first) }).type).toBe("checkout.paid");
  });

  it("W2 — refuses a tampered body, a re-serialised body and another secret", () => {
    const tampered = first.body.replace("5000", "50000");
    const reformatted = JSON.stringify(JSON.parse(first.body), null, 2);
    expect(codeOf(() => constructEvent({ payload: tampered, headers: headersOf(first), secret: SECRET, now: at(first) }))).toBe("SIGNATURE_MISMATCH");
    expect(codeOf(() => constructEvent({ payload: reformatted, headers: headersOf(first), secret: SECRET, now: at(first) }))).toBe("SIGNATURE_MISMATCH");
    expect(codeOf(() => constructEvent({ payload: first.body, headers: headersOf(first), secret: "whsec_other", now: at(first) }))).toBe("SIGNATURE_MISMATCH");
  });

  it("W3 — refuses outside the 5-minute tolerance, both ways", () => {
    const run = (now: number) => codeOf(() => constructEvent({ payload: first.body, headers: headersOf(first), secret: SECRET, now }));
    expect(run(at(first) + 300)).toBe("ACCEPTED");
    expect(run(at(first) + 301)).toBe("TIMESTAMP_OUT_OF_TOLERANCE");
    expect(run(at(first) - 301)).toBe("TIMESTAMP_OUT_OF_TOLERANCE");
  });

  it("W4 — every malformed delivery is an ItajaSignatureError, never another error", () => {
    const base = { payload: first.body, secret: SECRET, now: at(first) };
    expect(codeOf(() => constructEvent({ ...base, headers: { "x-itaja-timestamp": first.timestamp } }))).toBe("SIGNATURE_MISSING");
    expect(codeOf(() => constructEvent({ ...base, headers: { ...headersOf(first), "x-itaja-timestamp": "yesterday" } }))).toBe("TIMESTAMP_INVALID");
    expect(codeOf(() => constructEvent({ ...base, headers: { ...headersOf(first), "x-itaja-signature": first.signature.replace("v1,", "v2,") } }))).toBe("SIGNATURE_SCHEME_UNSUPPORTED");
    expect(codeOf(() => constructEvent({ ...base, headers: headersOf(first), secret: "" }))).toBe("WEBHOOK_SECRET_MISSING");
    const notJson = signPayload({ payload: "not json", secret: SECRET, timestamp: at(first) });
    expect(codeOf(() => constructEvent({ ...base, payload: "not json", headers: notJson }))).toBe("PAYLOAD_INVALID");
  });

  it("W5 — accepts a rotation header carrying the old and the new signature", () => {
    const old = signPayload({ payload: first.body, secret: "whsec_old", timestamp: at(first) })["x-itaja-signature"]!;
    const header = `${old},${first.signature.slice(3)}`;
    const event = constructEvent({ payload: first.body, headers: { "x-itaja-signature": header, "x-itaja-timestamp": first.timestamp }, secret: SECRET, now: at(first) });
    expect(event.id).toBe("itaja_evt_txn_1");
  });
});

/** A delivery signed now, as Itaja would send it. */
function delivery(event: Record<string, unknown>, secret = SECRET) {
  const payload = JSON.stringify(event);
  return { payload, headers: { "content-type": "application/json", ...signPayload({ payload, secret }) } };
}

function post(handler: (r: Request) => Promise<Response>, d: ReturnType<typeof delivery>) {
  return handler(new Request("http://localhost/itaja/webhook", { method: "POST", headers: d.headers, body: d.payload }));
}

const paid = (id: string, mode: "live" | "sandbox" = "live") => ({
  id,
  type: "checkout.paid",
  apiVersion: "v1",
  mode,
  createdAt: new Date().toISOString(),
  data: { checkoutId: "chk_1", productId: null, transactionId: "txn_1", amount: 5000, currency: "XOF", paidAt: new Date().toISOString() },
});

describe("createWebhookHandler", () => {
  it("W6 — the same event id twice runs the handler once, and both deliveries get 200", async () => {
    const calls: string[] = [];
    const handler = createWebhookHandler({ secret: SECRET, mode: "live", on: { "checkout.paid": (e) => void calls.push(e.data.checkoutId) } });
    const a = await post(handler, delivery(paid("evt_dupe")));
    const b = await post(handler, delivery(paid("evt_dupe")));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await b.json()).toEqual({ received: true, outcome: "duplicate" });
    expect(calls).toEqual(["chk_1"]);
  });

  it("W7 — a throwing handler answers 500 and is not marked: the redelivery runs it again", async () => {
    let attempts = 0;
    const errors: unknown[] = [];
    const handler = createWebhookHandler({
      secret: SECRET,
      mode: "live",
      on: {
        "checkout.paid": () => {
          attempts += 1;
          if (attempts === 1) throw new Error("database down");
        },
      },
      onError: (error) => errors.push(error),
    });
    expect((await post(handler, delivery(paid("evt_retry")))).status).toBe(500);
    expect((await post(handler, delivery(paid("evt_retry")))).status).toBe(200);
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it("W8 — an event of the other mode is acknowledged and ignored", async () => {
    const calls: string[] = [];
    const handler = createWebhookHandler({ secret: SECRET, mode: "live", on: { "*": (e) => void calls.push(e.id) } });
    const response = await post(handler, delivery(paid("evt_sandbox", "sandbox")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, outcome: "ignored_mode" });
    expect(calls).toEqual([]);
  });

  it("W9 — an unknown event type reaches '*' and nothing throws", async () => {
    const seen: AnyItajaEvent[] = [];
    const handler = createWebhookHandler({ secret: SECRET, mode: "live", on: { "*": (e) => void seen.push(e) } });
    const response = await post(handler, delivery({ id: "evt_new", type: "customer.updated", apiVersion: "v1", createdAt: new Date().toISOString(), data: { customerId: "cus_1" } }));
    expect(response.status).toBe(200);
    expect(seen.map((e) => e.type)).toEqual(["customer.updated"]);
  });

  it("refuses a bad signature with 400 and a GET with 405, calling nothing", async () => {
    let called = false;
    const handler = createWebhookHandler({ secret: SECRET, mode: "live", on: { "*": () => void (called = true) } });
    expect((await post(handler, delivery(paid("evt_bad"), "whsec_wrong"))).status).toBe(400);
    expect((await handler(new Request("http://localhost/itaja/webhook"))).status).toBe(405);
    expect(called).toBe(false);
  });

  it("the memory store forgets the oldest ids past its bound", () => {
    const store = memoryDedupeStore({ max: 2 });
    store.add("a");
    store.add("b");
    store.add("c");
    expect([store.has("a"), store.has("b"), store.has("c")]).toEqual([false, true, true]);
  });
});

describe("toNodeHandler (Express / node:http)", () => {
  let server: Server;
  let url = "";
  const handled: string[] = [];

  beforeAll(async () => {
    const node = toNodeHandler(createWebhookHandler({ secret: SECRET, mode: "live", on: { "checkout.paid": (e) => void handled.push(e.id) } }));
    server = createServer((req, res) => {
      if (req.url === "/parsed") {
        // What `express.json()` leaves behind: the body already parsed.
        void node(Object.assign(req, { body: { already: "parsed" } }), res).catch(() => {
          res.statusCode = 400;
          res.end("raw body unavailable");
        });
        return;
      }
      void node(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("W10 — verifies over a real socket with the raw body", async () => {
    const d = delivery(paid("evt_node"));
    const response = await axios.post(`${url}/itaja/webhook`, d.payload, { headers: d.headers, transformRequest: [(b: string) => b], validateStatus: () => true });
    expect(response.status).toBe(200);
    expect(handled).toEqual(["evt_node"]);
  });

  it("W10 — refuses a body a JSON parser already consumed, instead of guessing", async () => {
    const d = delivery(paid("evt_parsed"));
    const response = await axios.post(`${url}/parsed`, d.payload, { headers: d.headers, transformRequest: [(b: string) => b], validateStatus: () => true });
    expect(response.status).toBe(400);
    expect(handled).not.toContain("evt_parsed");
  });
});
