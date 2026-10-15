# @itaja/node

Itaja for Node.js servers. Declare what you sell in code, push it, mount one
route, react to typed events — the merchant journey of
[ADR 0015](https://github.com/itaja/itaja-services/blob/develop/backend/docs/adr/0015-les-sdk-declarer-pousser-monter-reagir.md),
identical in every Itaja SDK.

```bash
pnpm add @itaja/node        # npm i @itaja/node · bun add @itaja/node
```

> **Server only.** This package holds your secret API key. Never ship it to a
> browser or a mobile app.

## 1. Declare

```ts
// itaja.config.ts
import { createItaja, creditPack, credits, feature, group, license, offer, plan } from "@itaja/node";

export const messages = feature({ id: "messages", type: "metered" });
export const exportCsv = feature({ id: "export", type: "boolean" });

const app = group({ id: "app", name: "My App" });
export const free = plan({ id: "free", group: app, default: true,
  includes: [messages({ limit: 100, reset: "month" })] });
export const pro = plan({ id: "pro", group: app,
  price: { amount: 5000, currency: "XOF", interval: "month" }, trial: { days: 7 },
  includes: [messages({ limit: 2000, reset: "month" }), exportCsv()] });

const tokens = credits({ id: "tokens", name: "AI tokens", coinName: "Tokens" });
export const small = creditPack({ id: "small", of: tokens, credits: 100,
  price: { amount: 1000, currency: "XOF" } });

export const desktop = license({ id: "desktop", name: "Desktop app", devices: 3,
  duration: "days-365", price: { amount: 25000, currency: "XOF" } });
export const ebook = offer({ id: "ebook", name: "The guide",
  price: { amount: 3000, currency: "XOF" } });

export const itaja = createItaja({
  catalog: [messages, exportCsv, free, pro, small, desktop, ebook],
  on: {
    "checkout.paid": ({ data }) => fulfil(data.checkoutId),
    "credits.low": ({ data }) => remind(data.customerId, data.balance),
  },
});
export default itaja;
```

| Builder | Sells as | Declares |
|---|---|---|
| `feature({ id, type })` | — | a right: `boolean` (access) or `metered` (quota per period) |
| `group({ id, name })` + `plan({ id, group, price?, trial?, default?, includes })` | subscription | a subscription product and its plans; a customer holds one plan per group; `default` is the free fallback |
| `credits({ id, name, coinName? })` + `creditPack({ id, of, credits, price })` | credits | a credit currency and the packs that sell it |
| `license({ id, name, devices, duration?, price })` | licence key | software unlocked on N devices |
| `offer({ id, name, price })` | payment link | a one-off sale |

Ids are **yours** and are inferred as literal types. Amounts are in **major
units** of their currency (`5000` XOF, `9.99` EUR), as in the API. Mistakes the
API would refuse — an undeclared feature, two default plans, a paid plan
without a price, an invalid id — are refused as soon as the file loads.

## 2. Push

```bash
export ITAJA_API_KEY=itjs_…          # sandbox key; itjp_… writes the live catalogue
npx itaja status                     # what differs; exit 1 if anything does
npx itaja push                       # shows the diff, asks, applies
npx itaja push --yes                 # in CI / your deploy pipeline
npx itaja catalog                    # the canonical JSON your code declares
```

The mode follows the key: an `itjs_` key pushes the sandbox catalogue, an `itjp_`
key the live one. Changing a plan's price or features creates a **new version**
(running subscriptions keep theirs); an item you remove is **archived**, never
deleted. Products made in the dashboard are never touched.

## 3. Mount

One route receives Itaja's webhooks. It verifies the signature on the raw body,
drops a delivery it already processed, ignores events of the other mode, calls
your handlers, and answers `500` when one throws so Itaja delivers again.

```ts
// Next.js — app/itaja/webhook/route.ts
import { itaja } from "@/itaja.config";
export const POST = itaja.handler;

// Hono / Bun / Elysia / Workers
app.post("/itaja/webhook", (c) => itaja.handler(c.req.raw));

// Express — before express.json(), or with the raw body on this path
app.post("/itaja/webhook", express.raw({ type: "*/*" }), itaja.nodeHandler);
```

Set `ITAJA_WEBHOOK_SECRET` to the endpoint's signing secret from the dashboard.
Processed event ids are kept in memory; behind several instances, pass a shared
store:

```ts
createItaja({ …, dedupe: { has: (id) => redis.exists(`itaja:${id}`).then(Boolean),
                           add: (id) => redis.set(`itaja:${id}`, 1, "EX", 86400) } });
```

Test your handler locally with a signed sample event:

```bash
ITAJA_WEBHOOK_SECRET=… npx itaja trigger checkout.paid --url http://localhost:3000/itaja/webhook
```

## 4. React

`on` is typed per event: `data` has the fields Itaja documents for that type.
`"*"` receives every delivery, including types this version does not know yet.

| Family | Events |
|---|---|
| Checkout | `checkout.paid` |
| Credits | `credits.granted` · `credits.consumed` · `credits.expired` · `credits.low` · `credits.clawed_back` |
| Licences | `license.issued` · `activated` · `deactivated` · `revoked` · `expired` · `rotated` · `suspended` · `resumed` · `updated` |
| Billing | `invoice.paid` · `invoice.payment_failed` · `subscription.past_due` · `subscription.canceled` |

Verify a delivery yourself, without the handler:

```ts
import { constructEvent } from "@itaja/node";
const event = constructEvent({ payload: rawBody, headers, secret: process.env.ITAJA_WEBHOOK_SECRET! });
```

## Calling the API

Products are named by your catalogue id; a product made in the dashboard can be
named by its Itaja id (`{ productId: "prd_…" }`).

```ts
await itaja.checkout.create({ homeUrl: "https://shop.example/thanks", currency: "XOF",
  lineItems: [{ name: "Sandals", quantity: 1, unitPrice: 5000 }] });   // → { checkoutUrl, … }

await itaja.credits.buy({ product: "tokens", pack: "small", customerId, homeUrl });
await itaja.credits.consume({ product: "tokens", customerId, amount: 3 });
await itaja.credits.balance({ product: "tokens", customerId });

await itaja.licenses.issue({ product: "desktop", customerId });
await itaja.licenses.revoke({ product: "desktop", keyId, reason: "chargeback" });

await itaja.subscriptions.list({ customerId });
await itaja.subscriptions.cancel(subscriptionId);              // at period end
await itaja.customers.get("user_42");                          // your own customer id works too
```

Anything else: `itaja.request("GET", "/me")`.

**Coming with the API** — `subscribe()` (one call for new, upgrade, downgrade,
cancel-to-free), `check()` and `report()` for entitlements are declared and
typed; they throw `NOT_YET_AVAILABLE` until the API serves them
(itaja-services #465, #466).

## Errors and retries

Every failure is an `ItajaError` with a stable `code`, the HTTP `status` and the
API's `details` — `ItajaValidationError` (400/422), `ItajaAuthenticationError`
(401), `ItajaPermissionError` (403), `ItajaNotFoundError` (404),
`ItajaConflictError` (409), `ItajaRateLimitError` (429), `ItajaServerError`
(5xx), `ItajaConnectionError`, `ItajaSignatureError`, `ItajaConfigError`. No
error ever contains your key.

Every write carries an `Idempotency-Key` — one per call, reused on its retries
— so retrying a write can never run it twice. Network errors, `5xx`, `429` and
`409 IDEMPOTENCY_KEY_IN_PROGRESS` are retried twice, honouring `Retry-After`.
Pass `{ idempotencyKey }` to make **your own** retries safe too (an order id,
for instance).

## Configuration

| Option | Environment | Default |
|---|---|---|
| `apiKey` | `ITAJA_API_KEY` | — |
| `webhookSecret` | `ITAJA_WEBHOOK_SECRET` | — (needed only by the handler) |
| `baseUrl` | `ITAJA_API_URL` | `https://api.getitaja.com/api/v1` |
| `timeoutMs` / `maxRetries` | — | `30000` / `2` |

There is no `environment` option: the key's prefix decides sandbox or live.

## Development

```bash
pnpm install
pnpm test            # unit + contract suites, no network
pnpm test:e2e        # against a real developer API: ITAJA_E2E_API_KEY=itjs_… ITAJA_E2E_API_URL=…
pnpm generate        # regenerate src/generated/openapi.ts from spec/openapi.json
```

`spec/openapi.json` and `spec/catalog.schema.json` are copies of the developer
API's exported documents (`itaja-services`, `backend/apps/dev-api`).
`tests/fixtures/signature-vectors.json` was signed by the API's own
`signOutboundWebhook`. The e2e suite writes
`tests/e2e/__fixtures__/catalog-push-walk.json` and compares every later run
with it.

## License

MIT
