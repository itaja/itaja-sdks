/**
 * Webhook verification and the mounted handler (ADR 0015 D6).
 *
 * Itaja signs with Standard Webhooks (https://www.standardwebhooks.com) and
 * nothing else: `webhook-id`, `webhook-timestamp`, `webhook-signature`.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * W1.  A signature the delivery service produced is refused (the two sides
 *      disagree on the signed content, the key, the encoding or the header
 *      format). Covered by the shared vectors, one per kind of secret.
 * W1a. We and the official `standardwebhooks` library disagree: what it signs
 *      we refuse, what we sign it refuses, or the signatures differ by a byte.
 * W1b. A legacy `whsec_<48 hex>` secret stops working: its key must be the 36
 *      bytes the hex text decodes to AS BASE64, not the hex bytes, not the text.
 * W1c. A secret that is not base64 is refused or mis-keyed, instead of falling
 *      back to its UTF-8 bytes like the emitter does.
 * W2.  A tampered body, a body re-serialised by a JSON parser, another
 *      `webhook-id`, or a signature made with another secret is accepted.
 * W3.  A delivery older (or newer) than the tolerance is accepted — a captured
 *      request replays forever.
 * W4.  A missing header (any of the three), a non-numeric timestamp, or a
 *      header with no `v1` entry throws something else than
 *      ItajaSignatureError (a 500 instead of a 400), or shares one code.
 * W5.  During a secret rotation (`v1,<new> v1,<old>`, space-separated) the
 *      delivery is refused; or an entry of an unknown version breaks the parse.
 * W6.  The same event id delivered twice runs the handlers twice.
 * W7.  A handler that throws is acknowledged (200) or marked processed: Itaja
 *      never redelivers and the event is lost.
 * W8.  A sandbox event reaches a live key's handlers (or the reverse).
 * W9.  An event type the SDK does not know throws instead of reaching "*".
 * W10. The Node adapter loses the raw body (signature fails), or silently
 *      accepts a body Express already parsed.
 * W11. The removed `x-itaja-signature` / `x-itaja-timestamp` scheme is still
 *      accepted, alone or as a fallback.
 * W12. A signature that is not base64, or of the wrong length, crashes.
 * W13. The body is decoded before it is signed: two different byte sequences
 *      that decode to the same text pass for the same body.
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { Webhook } from "standardwebhooks";
import {
  ID_HEADER,
  ItajaSignatureError,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  constructEvent,
  createWebhookHandler,
  memoryDedupeStore,
  signPayload,
  toNodeHandler,
  type AnyItajaEvent,
} from "../src/index.js";

interface Vector {
  name: string;
  kind: "base64-secret" | "legacy-hex-secret" | "rotation" | "utf8-fallback-secret";
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  signature: string;
}
const vectors = (JSON.parse(readFileSync(new URL("../../../spec/signature-vectors.json", import.meta.url), "utf8")) as { vectors: Vector[] }).vectors;
const ofKind = (kind: Vector["kind"]): Vector => {
  const found = vectors.find((v) => v.kind === kind);
  if (!found) throw new Error(`spec/signature-vectors.json has no "${kind}" vector`);
  return found;
};
const first = ofKind("base64-secret");
const legacy = ofKind("legacy-hex-secret");
const SECRET = first.secret;
const at = (v: { timestamp: string }) => Number(v.timestamp);
const headersOf = (v: Pick<Vector, "id" | "timestamp" | "signature">): Record<string, string> => ({
  "webhook-id": v.id,
  "webhook-timestamp": v.timestamp,
  "webhook-signature": v.signature,
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ItajaSignatureError);
    expect((error as ItajaSignatureError).status).toBe(400);
    return (error as ItajaSignatureError).code;
  }
  return "ACCEPTED";
}

describe("constructEvent", () => {
  it("the header names are Standard Webhooks' own", () => {
    expect([ID_HEADER, TIMESTAMP_HEADER, SIGNATURE_HEADER]).toEqual(["webhook-id", "webhook-timestamp", "webhook-signature"]);
  });

  it("the vectors cover every kind of secret", () => {
    expect([...new Set(vectors.map((v) => v.kind))].sort()).toEqual(["base64-secret", "legacy-hex-secret", "rotation", "utf8-fallback-secret"]);
  });

  it.each(vectors)("W1 — accepts the shared vector: $name", (v) => {
    const event = constructEvent({ payload: v.body, headers: headersOf(v), secret: v.secret, now: at(v) });
    expect(event.id).toBe(JSON.parse(v.body).id);
  });

  it("W1 — reads the headers from a Headers object, in any casing, and ignores webhook-topic", () => {
    const h = new Headers({ "Webhook-Id": first.id, "WEBHOOK-TIMESTAMP": first.timestamp, "Webhook-Signature": first.signature, "webhook-topic": "checkout.paid" });
    expect(constructEvent({ payload: first.body, headers: h, secret: SECRET, now: at(first) }).type).toBe("checkout.paid");
  });

  it("W1b — a legacy whsec_<48 hex> secret is keyed by its base64 decoding (36 bytes)", () => {
    const text = legacy.secret.slice("whsec_".length);
    expect(text).toMatch(/^[0-9a-f]{48}$/);
    const key = Buffer.from(text, "base64");
    expect(key).toHaveLength(36);
    const expected = createHmac("sha256", key).update(`${legacy.id}.${legacy.timestamp}.${legacy.body}`).digest("base64");
    expect(legacy.signature).toBe(`v1,${expected}`);
    expect(signPayload({ payload: legacy.body, secret: legacy.secret, id: legacy.id, timestamp: at(legacy) })["webhook-signature"]).toBe(legacy.signature);
    // Neither the hex bytes nor the text itself is the key.
    for (const wrong of [Buffer.from(text, "hex"), Buffer.from(text, "utf8"), Buffer.from(legacy.secret, "utf8")]) {
      const forged = `v1,${createHmac("sha256", wrong).update(`${legacy.id}.${legacy.timestamp}.${legacy.body}`).digest("base64")}`;
      expect(codeOf(() => constructEvent({ payload: legacy.body, headers: headersOf({ ...legacy, signature: forged }), secret: legacy.secret, now: at(legacy) }))).toBe("SIGNATURE_MISMATCH");
    }
  });

  it("W1c — a secret that is not base64 is keyed by its UTF-8 bytes after whsec_", () => {
    const v = ofKind("utf8-fallback-secret");
    const key = Buffer.from(v.secret.slice("whsec_".length), "utf8");
    const expected = createHmac("sha256", key).update(`${v.id}.${v.timestamp}.${v.body}`).digest("base64");
    expect(v.signature).toBe(`v1,${expected}`);
    // Base64 alphabet but not canonical (wrong length, or padding bits set): the same fallback.
    for (const secret of ["whsec_abcde", "whsec_AB==", "whsec_", "whsec_====", "plain text secret"]) {
      const body = '{"id":"e1","type":"t","data":{}}';
      const text = secret.startsWith("whsec_") ? secret.slice(6) : secret;
      const mine = signPayload({ payload: body, secret, id: "m1", timestamp: 1760500000 });
      expect(mine["webhook-signature"], secret).toBe(`v1,${createHmac("sha256", Buffer.from(text, "utf8")).update(`m1.1760500000.${body}`).digest("base64")}`);
      expect(constructEvent({ payload: body, headers: mine, secret, now: 1760500000 }).id).toBe("e1");
    }
  });

  it("W2 — refuses a tampered body, a re-serialised body, another id and another secret", () => {
    const tampered = first.body.replace("5000", "50000");
    const reformatted = JSON.stringify(JSON.parse(first.body), null, 2);
    const base = { payload: first.body, headers: headersOf(first), secret: SECRET, now: at(first) };
    expect(codeOf(() => constructEvent({ ...base, payload: tampered }))).toBe("SIGNATURE_MISMATCH");
    expect(codeOf(() => constructEvent({ ...base, payload: reformatted }))).toBe("SIGNATURE_MISMATCH");
    expect(codeOf(() => constructEvent({ ...base, headers: { ...headersOf(first), "webhook-id": "itaja_evt_other" } }))).toBe("SIGNATURE_MISMATCH");
    expect(codeOf(() => constructEvent({ ...base, secret: "whsec_other" }))).toBe("SIGNATURE_MISMATCH");
    expect(codeOf(() => constructEvent({ ...base, secret: legacy.secret }))).toBe("SIGNATURE_MISMATCH");
  });

  it("W3 — refuses outside the 5-minute tolerance, both ways, and the tolerance is configurable", () => {
    const run = (now: number, toleranceSeconds?: number) =>
      codeOf(() => constructEvent({ payload: first.body, headers: headersOf(first), secret: SECRET, now, toleranceSeconds }));
    expect(run(at(first) + 300)).toBe("ACCEPTED");
    expect(run(at(first) - 300)).toBe("ACCEPTED");
    expect(run(at(first) + 301)).toBe("TIMESTAMP_OUT_OF_TOLERANCE");
    expect(run(at(first) - 301)).toBe("TIMESTAMP_OUT_OF_TOLERANCE");
    expect(run(at(first) + 301, 600)).toBe("ACCEPTED");
    expect(run(at(first) + 11, 10)).toBe("TIMESTAMP_OUT_OF_TOLERANCE");
    // The timestamp is signed: moving it into the window does not help.
    const moved = { ...headersOf(first), "webhook-timestamp": String(at(first) + 301) };
    expect(codeOf(() => constructEvent({ payload: first.body, headers: moved, secret: SECRET, now: at(first) + 301 }))).toBe("SIGNATURE_MISMATCH");
  });

  it("W4 — every malformed delivery is an ItajaSignatureError with its own code", () => {
    const base = { payload: first.body, secret: SECRET, now: at(first) };
    const without = (name: string) => Object.fromEntries(Object.entries(headersOf(first)).filter(([key]) => key !== name));
    expect(codeOf(() => constructEvent({ ...base, headers: {} }))).toBe("SIGNATURE_MISSING");
    expect(codeOf(() => constructEvent({ ...base, headers: without("webhook-id") }))).toBe("SIGNATURE_MISSING");
    expect(codeOf(() => constructEvent({ ...base, headers: without("webhook-timestamp") }))).toBe("SIGNATURE_MISSING");
    expect(codeOf(() => constructEvent({ ...base, headers: without("webhook-signature") }))).toBe("SIGNATURE_MISSING");
    for (const bad of ["yesterday", "1760500000.5", "-1760500000", " 1760500000", "0x10"]) {
      expect(codeOf(() => constructEvent({ ...base, headers: { ...headersOf(first), "webhook-timestamp": bad } })), bad).toBe("TIMESTAMP_INVALID");
    }
    for (const bad of [first.signature.replace("v1,", "v2,"), "v1", "v1,", first.signature.slice(3), "v1a,abc v2,def"]) {
      expect(codeOf(() => constructEvent({ ...base, headers: { ...headersOf(first), "webhook-signature": bad } })), bad).toBe("SIGNATURE_SCHEME_UNSUPPORTED");
    }
    expect(codeOf(() => constructEvent({ ...base, headers: headersOf(first), secret: "" }))).toBe("WEBHOOK_SECRET_MISSING");
    const notJson = signPayload({ payload: "not json", secret: SECRET, timestamp: at(first) });
    expect(codeOf(() => constructEvent({ ...base, payload: "not json", headers: notJson }))).toBe("PAYLOAD_INVALID");
  });

  it("W5 — a rotation header carries one entry per secret, space-separated: one match is enough", () => {
    const rotation = ofKind("rotation");
    expect(rotation.signature.split(" ")).toHaveLength(2);
    const current = first.signature;
    const stale = signPayload({ payload: first.body, secret: "whsec_b2xkIHNlY3JldA==", id: first.id, timestamp: at(first) })["webhook-signature"]!;
    const run = (signature: string) => codeOf(() => constructEvent({ payload: first.body, headers: headersOf({ ...first, signature }), secret: SECRET, now: at(first) }));
    expect(run(`${stale} ${current}`)).toBe("ACCEPTED");
    expect(run(`${current} ${stale}`)).toBe("ACCEPTED");
    expect(run(stale)).toBe("SIGNATURE_MISMATCH");
    expect(run(`${stale} ${stale}`)).toBe("SIGNATURE_MISMATCH");
    // Entries of another version are skipped, wherever they sit.
    expect(run(`v2,${current.slice(3)}`)).toBe("SIGNATURE_SCHEME_UNSUPPORTED");
    expect(run(`v1a,AAAA ${current} v2,BBBB`)).toBe("ACCEPTED");
    expect(run(`v2,${current.slice(3)} ${stale}`)).toBe("SIGNATURE_MISMATCH");
  });

  it("W11 — the removed x-itaja-* scheme is refused, alone or next to the new headers", () => {
    const old = {
      "x-itaja-timestamp": first.timestamp,
      "x-itaja-signature": `v1,${createHmac("sha256", SECRET).update(`${first.timestamp}.${first.body}`).digest("base64")}`,
    };
    const base = { payload: first.body, secret: SECRET, now: at(first) };
    expect(codeOf(() => constructEvent({ ...base, headers: old }))).toBe("SIGNATURE_MISSING");
    const wrongNew = { ...headersOf(first), "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
    expect(codeOf(() => constructEvent({ ...base, headers: { ...old, ...wrongNew } }))).toBe("SIGNATURE_MISMATCH");
  });

  it.each(["!!!not-base64!!!", "AAAA", Buffer.alloc(64, 120).toString("base64"), ""])("W12 — a junk signature fails cleanly: %j", (junk) => {
    const headers = headersOf({ ...first, signature: `v1,${junk} v1,${junk}` });
    expect(codeOf(() => constructEvent({ payload: first.body, headers, secret: SECRET, now: at(first) }))).toMatch(/^SIGNATURE_(MISMATCH|SCHEME_UNSUPPORTED)$/);
  });

  it("W13 — the signature covers the raw bytes, not their decoded text", () => {
    const bytes = (last: number) => Buffer.concat([Buffer.from('{"id":"evt_raw","type":"t","data":{"label":"'), Buffer.from([last]), Buffer.from('"}}')]);
    const [a, b] = [bytes(0xff), bytes(0xfe)];
    expect(a.toString("utf8")).toBe(b.toString("utf8")); // both decode to U+FFFD
    const headers = signPayload({ payload: a, secret: SECRET, id: "m_raw", timestamp: 1760500000 });
    expect(constructEvent({ payload: a, headers, secret: SECRET, now: 1760500000 }).id).toBe("evt_raw");
    expect(constructEvent({ payload: new Uint8Array(a), headers, secret: SECRET, now: 1760500000 }).id).toBe("evt_raw");
    expect(codeOf(() => constructEvent({ payload: b, headers, secret: SECRET, now: 1760500000 }))).toBe("SIGNATURE_MISMATCH");
  });
});

describe("agreement with the official standardwebhooks library", () => {
  afterEach(() => void vi.useRealTimers());

  const agreed = vectors.filter((v) => v.kind === "base64-secret" || v.kind === "legacy-hex-secret" || v.kind === "rotation");

  it("covers the base64 and the legacy hex secrets", () => {
    expect(new Set(agreed.map((v) => v.kind))).toEqual(new Set(["base64-secret", "legacy-hex-secret", "rotation"]));
  });

  it.each(agreed)("W1a — the library verifies the shared vector: $name", (v) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(v) * 1000);
    expect(new Webhook(v.secret).verify(v.body, headersOf(v))).toEqual(JSON.parse(v.body));
  });

  it.each(agreed.filter((v) => v.kind !== "rotation"))("W1a — the library, our signer and the vector agree byte for byte: $name", (v) => {
    const theirs = new Webhook(v.secret).sign(v.id, new Date(at(v) * 1000), v.body);
    const ours = signPayload({ payload: v.body, secret: v.secret, id: v.id, timestamp: at(v) });
    expect(theirs).toBe(v.signature);
    expect(ours).toEqual(headersOf(v));
  });

  it.each([first.secret, legacy.secret])("W1a — what one side signs now, the other verifies: %s", (secret) => {
    const body = JSON.stringify({ id: "itaja_evt_live", type: "credits.low", apiVersion: "v1", data: { label: "été — ✓", balance: 3 } });
    const library = new Webhook(secret);

    const ours = signPayload({ payload: body, secret, id: "msg_ours" });
    expect(library.verify(body, ours)).toEqual(JSON.parse(body));

    const now = Math.floor(Date.now() / 1000);
    const theirs = { "webhook-id": "msg_theirs", "webhook-timestamp": String(now), "webhook-signature": library.sign("msg_theirs", new Date(now * 1000), body) };
    expect(constructEvent({ payload: body, headers: theirs, secret }).id).toBe("itaja_evt_live");
    expect(signPayload({ payload: body, secret, id: "msg_theirs", timestamp: now })).toEqual(theirs);
  });

  it("W1a — both sides refuse the same tampered delivery", () => {
    const body = '{"id":"itaja_evt_live","type":"credits.low","data":{"balance":3}}';
    const headers = signPayload({ payload: body, secret: SECRET, id: "msg_1" });
    const tampered = body.replace("3", "4");
    expect(() => new Webhook(SECRET).verify(tampered, headers)).toThrow(/No matching signature/);
    expect(codeOf(() => constructEvent({ payload: tampered, headers, secret: SECRET }))).toBe("SIGNATURE_MISMATCH");
  });
});

describe("signPayload", () => {
  it("returns the three headers, a fresh id per call unless one is given", () => {
    const a = signPayload({ payload: "{}", secret: SECRET });
    const b = signPayload({ payload: "{}", secret: SECRET });
    expect(Object.keys(a).sort()).toEqual(["webhook-id", "webhook-signature", "webhook-timestamp"]);
    expect(a["webhook-id"]).not.toBe(b["webhook-id"]);
    expect(a["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(signPayload({ payload: "{}", secret: SECRET, id: "msg_fixed" })["webhook-id"]).toBe("msg_fixed");
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
