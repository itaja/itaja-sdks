#!/usr/bin/env node
/**
 * Regenerates `spec/signature-vectors.json`: `node spec/generate-signature-vectors.mjs`.
 *
 * Itaja signs every webhook with Standard Webhooks (https://www.standardwebhooks.com):
 *
 *     webhook-id:        <message id, the same on every retry>
 *     webhook-timestamp: <unix seconds>
 *     webhook-signature: v1,<base64>[ v1,<base64>]      one entry per valid secret
 *
 *     signature = base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>"))
 *     key       = base64-decoded part of the secret after `whsec_`; a part that is not
 *                 canonical base64 is used as its UTF-8 bytes instead.
 *
 * This script is deliberately independent of the SDKs (node:crypto only) and fully
 * deterministic: fixed ids, timestamps, bodies and secrets, no clock, no randomness.
 * None of these secrets was ever issued to anyone.
 *
 * `packages/node/tests/webhooks.test.ts` checks the vectors against the official
 * `standardwebhooks` library, so a mistake here cannot go unnoticed.
 */
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const PREFIX = "whsec_";
const bytes = (from) => Buffer.from(Array.from({ length: 32 }, (_, i) => from + i));

/** New format: `whsec_` + base64 of 32 bytes (here 0x00..0x1f). */
const BASE64_SECRET = PREFIX + bytes(0).toString("base64");
/** The secret that replaces it during a rotation (0x20..0x3f). */
const ROTATED_SECRET = PREFIX + bytes(32).toString("base64");
/** Legacy Itaja format: `whsec_` + 48 hex characters. Hex is valid base64: it decodes to 36 bytes. */
const LEGACY_HEX_SECRET = PREFIX + "0123456789abcdef".repeat(3);
/** Not base64 (underscores): the key is the UTF-8 bytes of what follows `whsec_`. */
const UTF8_SECRET = PREFIX + "conformance_not_a_real_secret";

function key(secret) {
  const raw = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(raw) && raw.length % 4 === 0) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length > 0 && decoded.toString("base64") === raw) return decoded;
  }
  return Buffer.from(raw, "utf8");
}

function sign(secret, id, timestamp, body) {
  return "v1," + createHmac("sha256", key(secret)).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
}

const checkoutPaid = JSON.stringify({
  id: "itaja_evt_txn_1",
  type: "checkout.paid",
  apiVersion: "v1",
  mode: "live",
  createdAt: "2026-10-15T10:00:00.000Z",
  data: { checkoutId: "chk_1", productId: null, transactionId: "txn_1", amount: 5000, currency: "XOF", paidAt: "2026-10-15T10:00:00.000Z" },
});
const licenseActivated = JSON.stringify({
  id: "itaja_evt_2",
  type: "license.activated",
  apiVersion: "v1",
  createdAt: "2026-10-15T10:00:00.000Z",
  data: { productId: "prd_1", keyId: "key_1", key: "ITJ-••••-••••-ABCD", instanceId: "i1", label: "Ordinateur d'Awa — été", activationsUsed: 1, activationsMax: 3, expiresAt: null, deviceFingerprintHash: "sha256:x" },
});
const creditsLow = JSON.stringify({
  id: "itaja_evt_3",
  type: "credits.low",
  apiVersion: "v1",
  mode: "sandbox",
  createdAt: "2026-10-15T10:00:00.000Z",
  data: { productId: "prd_2", walletId: "cwl_1", customerId: "cus_1", balance: 10, threshold: 20, idempotencyKey: "k" },
});
const invoicePaid = JSON.stringify({
  id: "itaja_evt_4",
  type: "invoice.paid",
  apiVersion: "v1",
  mode: "live",
  createdAt: "2026-10-15T10:00:00.000Z",
  data: { productId: "prd_3", contractId: "sub_1", customerId: "cus_1", planId: "pln_1", invoiceId: "inv_1", invoiceNumber: 7, amount: 15000, currency: "XOF", periodStart: "2026-10-15T10:00:00.000Z", periodEnd: "2026-11-15T10:00:00.000Z", dueDate: "2026-10-15T10:00:00.000Z", paidAt: "2026-10-15T10:00:00.000Z" },
});
const licenseRevoked = JSON.stringify({
  id: "itaja_evt_5",
  type: "license.revoked",
  apiVersion: "v1",
  createdAt: "2026-10-15T10:00:00.000Z",
  data: { productId: "prd_1", keyId: "key_1", key: "ITJ-••••-••••-ABCD", previousStatus: "ACTIVE", reason: null },
});

/** One vector: what the receiver holds (`secret`), and what arrives. */
function vector(name, kind, secret, id, timestamp, body, signedWith = [secret]) {
  return {
    name,
    kind,
    secret,
    id,
    timestamp: String(timestamp),
    body,
    signature: signedWith.map((s) => sign(s, id, timestamp, body)).join(" "),
  };
}

const document = {
  scheme: "standard-webhooks",
  signedContent: "<webhook-id>.<webhook-timestamp>.<raw body>",
  headers: { id: "webhook-id", timestamp: "webhook-timestamp", signature: "webhook-signature" },
  generatedBy: "spec/generate-signature-vectors.mjs",
  vectors: [
    vector("base64 secret: checkout.paid", "base64-secret", BASE64_SECRET, "itaja_evt_txn_1", 1760500000, checkoutPaid),
    vector("base64 secret: unicode body", "base64-secret", BASE64_SECRET, "msg_conformance_unicode", 1760500001, licenseActivated),
    vector("legacy whsec_<48 hex> secret: sandbox credits.low", "legacy-hex-secret", LEGACY_HEX_SECRET, "itaja_evt_3", 1760500002, creditsLow),
    // Mid-rotation: the delivery carries the new secret's signature first, then the previous
    // one's. This receiver still holds the previous secret, so only the second entry matches.
    vector("rotation: two signatures, the receiver holds the previous secret", "rotation", BASE64_SECRET, "itaja_evt_4", 1760500003, invoicePaid, [ROTATED_SECRET, BASE64_SECRET]),
    vector("non-base64 secret: UTF-8 fallback", "utf8-fallback-secret", UTF8_SECRET, "itaja_evt_5", 1760500004, licenseRevoked),
  ],
};

writeFileSync(new URL("./signature-vectors.json", import.meta.url), JSON.stringify(document, null, 2) + "\n");
console.log(`Wrote ${document.vectors.length} vectors.`);
