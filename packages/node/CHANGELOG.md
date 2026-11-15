# Changelog — @itaja/node

## 0.4.0 — unreleased

### ⚠ BREAKING CHANGES

- **Webhook signatures are verified with [Standard Webhooks](https://www.standardwebhooks.com) only.**
  The SDK now reads `webhook-id`, `webhook-timestamp` and `webhook-signature`
  (`v1,<base64>`, several entries space-separated during a secret rotation, one match is
  enough). The signed content is `<webhook-id>.<webhook-timestamp>.<raw body>`, HMAC-SHA256
  keyed with the base64-decoded part of the secret after `whsec_` (a part that is not
  canonical base64 is used as its raw UTF-8 bytes, like the emitter does).
- The previous scheme — `x-itaja-signature: v1,<b64>[,<b64>]` + `x-itaja-timestamp`, signed
  content `<timestamp>.<raw body>`, keyed with the `whsec_…` string itself — is **removed**:
  a delivery that only carries it is refused with `SIGNATURE_MISSING`.
- `signPayload` now returns three headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`)
  and takes an optional message id (a fresh `msg_…` by default).

Existing `whsec_<48 hex>` secrets keep working without rotation (hex is valid base64).
Upgrade before Itaja's delivery service switches to Standard Webhooks: an older SDK refuses
every new delivery. The public API names, the 5-minute tolerance, the constant-time
comparison and the error codes are unchanged.

### Other changes

- `constructEvent` and the webhook handlers verify the raw body bytes (no UTF-8 round trip).
- New exports: `ID_HEADER`, `SignInput`.
