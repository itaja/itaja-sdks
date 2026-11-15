/**
 * Outbound webhooks: what Itaja sends, how it is signed, and how the SDK checks
 * it (ADR 0015 D6).
 *
 * Itaja signs with Standard Webhooks (https://www.standardwebhooks.com), and
 * with nothing else:
 *
 *     webhook-id:        <message id, the same on every retry of the event>
 *     webhook-timestamp: <unix seconds>
 *     webhook-signature: v1,<base64>[ v1,<base64>]
 *
 *     signature = base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>"))
 *
 * The key is the secret without its `whsec_` prefix, base64-decoded. A legacy
 * `whsec_<48 hex>` secret needs no rotation: hex is valid base64, so it decodes
 * to 36 bytes like in any `standardwebhooks` library. A secret that is not
 * canonical base64 is used as its UTF-8 bytes, which is what the emitter does.
 *
 * Several space-separated entries arrive while a secret is rotated: one match
 * is enough, and an entry of another version than `v1` is skipped. The check
 * runs on the **raw** body, in constant time, and refuses a timestamp more than
 * `toleranceSeconds` (default 300) from now, in either direction.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ItajaSignatureError } from "./errors.js";

export const ID_HEADER = "webhook-id";
export const TIMESTAMP_HEADER = "webhook-timestamp";
export const SIGNATURE_HEADER = "webhook-signature";
export const SIGNATURE_VERSION = "v1";
export const SECRET_PREFIX = "whsec_";
export const DEFAULT_TOLERANCE_SECONDS = 300;

// ── Event payloads (the `data` of each topic, as documented) ────────────────

type Iso = string;

export interface CheckoutPaidData {
  checkoutId: string;
  /** `null` for a dynamic checkout (`checkoutSessions.create`), which has no product. */
  productId: string | null;
  transactionId: string;
  /** Major units of `currency`. */
  amount: number;
  currency: string;
  paidAt: Iso;
}

interface LicenseBase {
  productId: string;
  keyId: string;
  /** Masked: `ITJ-••••-••••-XXXX`. */
  key: string;
}
type LicenseState = { activationsMax: number | null; expiresAt: Iso | null; status: string };

export interface LicenseEventData {
  "license.issued": LicenseBase & {
    customerId: string | null;
    checkoutId: string | null;
    activationsMax: number | null;
    expiresAt: Iso | null;
    status: string;
  };
  "license.activated": LicenseBase & {
    instanceId: string;
    label: string | null;
    activationsUsed: number;
    activationsMax: number | null;
    expiresAt: Iso | null;
    deviceFingerprintHash: string | null;
  };
  "license.deactivated": LicenseBase & { instanceId: string; activationsUsed: number; activationsMax: number | null };
  "license.revoked": LicenseBase & { previousStatus: string; reason: string | null };
  "license.expired": LicenseBase & { expiresAt: Iso };
  "license.rotated": LicenseBase & { previousKeyId: string; previousKey: string; customerId: string | null; status: string };
  "license.suspended": LicenseBase & { previousStatus: string };
  "license.resumed": LicenseBase & { previousStatus: string };
  "license.updated": LicenseBase & { before: LicenseState; after: LicenseState };
}

interface CreditMovement {
  productId: string;
  walletId: string;
  customerId: string;
  /** Coin count, never money. */
  amount: number;
  delta: number;
  balanceAfter: number;
  reason: string | null;
}

export interface CreditEventData {
  "credits.granted": CreditMovement & { idempotencyKey: string };
  "credits.consumed": CreditMovement & { idempotencyKey: string };
  "credits.expired": CreditMovement;
  "credits.low": { productId: string; walletId: string; customerId: string; balance: number; threshold: number; idempotencyKey: string };
  "credits.clawed_back": CreditMovement & { checkoutId: string; granted: number; shortfall: number; idempotencyKey: string };
}

interface InvoiceFact {
  productId: string;
  contractId: string;
  customerId: string;
  planId: string;
  invoiceId: string;
  invoiceNumber: number;
  /** Major units of `currency`. */
  amount: number;
  currency: string;
  periodStart: Iso;
  periodEnd: Iso;
  dueDate: Iso;
}

export interface BillingEventData {
  "invoice.paid": InvoiceFact & { paidAt: Iso };
  "invoice.payment_failed": InvoiceFact & { failedAt: Iso };
  "subscription.past_due": {
    productId: string;
    contractId: string;
    customerId: string;
    planId: string;
    status: string;
    collectionMode: string;
    currentPeriodStart: Iso;
    currentPeriodEnd: Iso;
    invoiceId: string | null;
    invoiceNumber: number | null;
    pastDueSince: Iso;
  };
  "subscription.canceled": {
    productId: string;
    contractId: string;
    customerId: string;
    planId: string;
    status: "CANCELED" | "ENDED";
    reason: "merchant" | "period_end" | "provider_canceled" | "retries_exhausted";
    collectionMode: string;
    currentPeriodStart: Iso;
    currentPeriodEnd: Iso;
    canceledAt: Iso | null;
    endedAt: Iso | null;
  };
}

/** Every topic Itaja emits today, and the shape of its `data`. */
export interface EventDataMap extends LicenseEventData, CreditEventData, BillingEventData {
  "checkout.paid": CheckoutPaidData;
}

export type EventType = keyof EventDataMap;

/** The envelope every delivery carries. */
export interface ItajaEvent<T extends string = EventType> {
  /** `itaja_evt_…` — the identity a retried delivery keeps. */
  id: string;
  type: T;
  apiVersion: string;
  /** The collection mode of the fact. Absent on some older topics. */
  mode?: "sandbox" | "live";
  createdAt: Iso;
  data: T extends EventType ? EventDataMap[T] : Record<string, unknown>;
}

/** Any delivery, typed by its `type` when the SDK knows it. */
export type AnyItajaEvent = { [T in EventType]: ItajaEvent<T> }[EventType] | ItajaEvent<string>;

// ── Verification ────────────────────────────────────────────────────────────

export interface VerifyInput {
  /** The body exactly as received — a re-serialised JSON fails, by design. */
  payload: string | Uint8Array;
  /**
   * Request headers (any casing), or a `Headers` object. `webhook-id`,
   * `webhook-timestamp` and `webhook-signature` are read from it.
   */
  headers: Headers | Record<string, string | string[] | undefined>;
  secret: string;
  toleranceSeconds?: number;
  /** For tests: the current time in seconds. */
  now?: number;
}

/**
 * Checks a delivery and returns its event. Throws `ItajaSignatureError`, whose
 * `code` says why:
 *
 * | `code` | The delivery… |
 * |---|---|
 * | `WEBHOOK_SECRET_MISSING` | cannot be checked: no secret was given |
 * | `SIGNATURE_MISSING` | lacks `webhook-id`, `webhook-timestamp` or `webhook-signature` |
 * | `TIMESTAMP_INVALID` | has a `webhook-timestamp` that is not unix seconds |
 * | `TIMESTAMP_OUT_OF_TOLERANCE` | is older or newer than the tolerance |
 * | `SIGNATURE_SCHEME_UNSUPPORTED` | has no `v1,<base64>` entry in `webhook-signature` |
 * | `SIGNATURE_MISMATCH` | carries no signature made with this secret |
 * | `PAYLOAD_INVALID` | is signed, but its body is not an Itaja event |
 */
export function constructEvent(input: VerifyInput): AnyItajaEvent {
  const body = typeof input.payload === "string" ? Buffer.from(input.payload, "utf8") : Buffer.from(input.payload);
  const id = readHeader(input.headers, ID_HEADER);
  const timestamp = readHeader(input.headers, TIMESTAMP_HEADER);
  const signatureHeader = readHeader(input.headers, SIGNATURE_HEADER);

  if (!input.secret) throw signatureError("No webhook secret. Set ITAJA_WEBHOOK_SECRET, or pass webhookSecret.", "WEBHOOK_SECRET_MISSING");
  if (!id || !timestamp || !signatureHeader) {
    throw signatureError("Missing webhook-id, webhook-timestamp or webhook-signature header.", "SIGNATURE_MISSING");
  }
  if (!/^[0-9]+$/.test(timestamp)) throw signatureError("webhook-timestamp is not a unix time.", "TIMESTAMP_INVALID");

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > tolerance) {
    throw signatureError(`Webhook timestamp is more than ${tolerance}s away from now.`, "TIMESTAMP_OUT_OF_TOLERANCE");
  }

  const candidates = v1Signatures(signatureHeader);
  if (candidates.length === 0) {
    throw signatureError("webhook-signature carries no v1,<base64> entry.", "SIGNATURE_SCHEME_UNSUPPORTED");
  }

  const expected = digest(input.secret, id, timestamp, body);
  let match = false;
  // No early exit: every candidate is compared, in constant time.
  for (const candidate of candidates) {
    const given = Buffer.from(candidate, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) match = true;
  }
  if (!match) throw signatureError("Webhook signature does not match.", "SIGNATURE_MISMATCH");

  let event: unknown;
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch {
    throw signatureError("Webhook body is not JSON.", "PAYLOAD_INVALID");
  }
  if (!isEnvelope(event)) throw signatureError("Webhook body is not an Itaja event.", "PAYLOAD_INVALID");
  return event as AnyItajaEvent;
}

export interface SignInput {
  /** The body exactly as it will be sent. */
  payload: string | Uint8Array;
  secret: string;
  /** `webhook-id`. Defaults to a fresh `msg_<uuid>`; a retry of the same event must reuse it. */
  id?: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
}

/**
 * Signs a payload the way Itaja does — for your tests and for `itaja trigger`.
 * Returns the three headers to send: `webhook-id`, `webhook-timestamp`,
 * `webhook-signature`.
 */
export function signPayload(input: SignInput): Record<string, string> {
  const id = input.id ?? `msg_${randomUUID()}`;
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const body = typeof input.payload === "string" ? Buffer.from(input.payload, "utf8") : Buffer.from(input.payload);
  return {
    [ID_HEADER]: id,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: `${SIGNATURE_VERSION},${digest(input.secret, id, timestamp, body).toString("base64")}`,
  };
}

/**
 * The HMAC key of a secret: what follows `whsec_`, base64-decoded. Text that is
 * not canonical base64 (it would not encode back to itself) is used as its
 * UTF-8 bytes — the emitter derives the key the same way.
 */
function secretKey(secret: string): Buffer {
  const text = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(text) && text.length % 4 === 0) {
    const decoded = Buffer.from(text, "base64");
    if (decoded.length > 0 && decoded.toString("base64") === text) return decoded;
  }
  return Buffer.from(text, "utf8");
}

/** HMAC-SHA256 over `<id>.<timestamp>.<raw body>`: the body bytes go in untouched. */
function digest(secret: string, id: string, timestamp: string, body: Buffer): Buffer {
  return createHmac("sha256", secretKey(secret)).update(`${id}.${timestamp}.`, "utf8").update(body).digest();
}

/** The base64 part of every `v1,<base64>` entry of a space-separated header. */
function v1Signatures(header: string): string[] {
  const signatures: string[] = [];
  for (const entry of header.split(/\s+/)) {
    const [version, signature] = entry.split(",");
    if (version === SIGNATURE_VERSION && signature) signatures.push(signature);
  }
  return signatures;
}

function isEnvelope(value: unknown): value is { id: string; type: string; data: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.type === "string" && typeof v.data === "object" && v.data !== null;
}

function readHeader(headers: VerifyInput["headers"], name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const record = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name) continue;
    const value = record[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}

function signatureError(message: string, code: string): ItajaSignatureError {
  return new ItajaSignatureError({ message, code, status: 400 });
}
