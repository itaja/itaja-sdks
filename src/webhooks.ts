/**
 * Outbound webhooks: what Itaja sends, how it is signed, and how the SDK checks
 * it (ADR 0015 D6).
 *
 * Signature (`docs/api-reference.md`, *Webhooks*):
 *
 *     x-itaja-timestamp: <unix seconds>
 *     x-itaja-signature: v1,<base64 HMAC-SHA256(secret, "<timestamp>.<raw body>")>[,<more>]
 *
 * Several signatures may follow `v1,` while a secret is rotated: one match is
 * enough. The check runs on the **raw** body, in constant time, and refuses a
 * timestamp more than `toleranceSeconds` (default 300) from now.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ItajaSignatureError } from "./errors.js";

export const SIGNATURE_HEADER = "x-itaja-signature";
export const TIMESTAMP_HEADER = "x-itaja-timestamp";
export const SIGNATURE_VERSION = "v1";
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
  /** Request headers (any casing), or a `Headers` object. */
  headers: Headers | Record<string, string | string[] | undefined>;
  secret: string;
  toleranceSeconds?: number;
  /** For tests: the current time in seconds. */
  now?: number;
}

/**
 * Checks a delivery and returns its event. Throws `ItajaSignatureError` when
 * the signature is missing, wrong, or older than the tolerance.
 */
export function constructEvent(input: VerifyInput): AnyItajaEvent {
  const body = typeof input.payload === "string" ? input.payload : Buffer.from(input.payload).toString("utf8");
  const signatureHeader = readHeader(input.headers, SIGNATURE_HEADER);
  const timestamp = readHeader(input.headers, TIMESTAMP_HEADER);

  if (!input.secret) throw signatureError("No webhook secret. Set ITAJA_WEBHOOK_SECRET, or pass webhookSecret.", "WEBHOOK_SECRET_MISSING");
  if (!signatureHeader || !timestamp) throw signatureError("Missing x-itaja-signature or x-itaja-timestamp header.", "SIGNATURE_MISSING");
  if (!/^\d+$/.test(timestamp)) throw signatureError("x-itaja-timestamp is not a unix time.", "TIMESTAMP_INVALID");

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > tolerance) {
    throw signatureError(`Webhook timestamp is more than ${tolerance}s away from now.`, "TIMESTAMP_OUT_OF_TOLERANCE");
  }

  const [version, ...signatures] = signatureHeader.split(",").map((part) => part.trim());
  if (version !== SIGNATURE_VERSION || signatures.length === 0) {
    throw signatureError("Unsupported signature scheme.", "SIGNATURE_SCHEME_UNSUPPORTED");
  }

  const expected = createHmac("sha256", input.secret).update(`${timestamp}.${body}`, "utf8").digest();
  const match = signatures.some((candidate) => {
    const given = Buffer.from(candidate, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!match) throw signatureError("Webhook signature does not match.", "SIGNATURE_MISMATCH");

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    throw signatureError("Webhook body is not JSON.", "PAYLOAD_INVALID");
  }
  if (!isEnvelope(event)) throw signatureError("Webhook body is not an Itaja event.", "PAYLOAD_INVALID");
  return event as AnyItajaEvent;
}

/**
 * Signs a payload the way Itaja does — for your tests and for `itaja trigger`.
 * Returns the two headers to send.
 */
export function signPayload(input: { payload: string; secret: string; timestamp?: number }): Record<string, string> {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", input.secret).update(`${timestamp}.${input.payload}`, "utf8").digest("base64");
  return { [SIGNATURE_HEADER]: `${SIGNATURE_VERSION},${digest}`, [TIMESTAMP_HEADER]: timestamp };
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
