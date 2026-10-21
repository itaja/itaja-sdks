# @itaja/node

Sell subscriptions, credits and licence keys from your own code. Declare what
you sell in TypeScript, push it to Itaja, mount one webhook route, react to typed
events.

```bash
npm i @itaja/node        # pnpm add @itaja/node · bun add @itaja/node
```

> **Server only.** This package holds your secret API key. Never ship it to a
> browser or a mobile app.

## Quick start

### 0. Configure

Put your keys in `.env` (never commit it) and pass them to `createItaja`:

```bash
# .env
ITAJA_API_KEY=itjs_…              # sandbox key; an itjp_… key works on the live catalogue
ITAJA_WEBHOOK_SECRET=whsec_…      # signing secret of your webhook endpoint (dashboard)
ITAJA_API_URL=https://api.getitaja.com/api/v1   # optional
```

```ts
createItaja({
  apiKey: process.env.ITAJA_API_KEY,
  webhookSecret: process.env.ITAJA_WEBHOOK_SECRET,
  baseUrl: process.env.ITAJA_API_URL,
  catalog: [/* … */],
});
```

Each option falls back to its variable when you leave it out. Pass other values to
use another account, a tenant's key or a staging API. The `itaja` CLI loads `.env`
and `.env.local` itself: nothing to export in your shell.

### 1. Declare what you sell

A free plan and a paid plan, with a quota that depends on the plan.

```ts
// itaja.config.ts
import { createItaja, feature, group, plan } from "@itaja/node";

// What the customer can do
const messages = feature({ id: "messages", type: "metered" });
const exportCsv = feature({ id: "export", type: "boolean" });

// One customer holds one plan of a group
const app = group({ id: "app", name: "My App" });

const free = plan({
  name: "Free",
  group: app,
  default: true, // everyone starts here, no payment
  includes: [messages({ limit: 100, reset: "month" })],
});

const pro = plan({
  name: "Pro",
  group: app,
  price: { amount: 5000, currency: "XOF", interval: "month" },
  trial: { days: 7 },
  includes: [messages({ limit: 2000, reset: "month" }), exportCsv()],
});

export const itaja = createItaja({
  apiKey: process.env.ITAJA_API_KEY,               // itjs_… sandbox, itjp_… live
  webhookSecret: process.env.ITAJA_WEBHOOK_SECRET, // signing secret of your webhook endpoint
  baseUrl: process.env.ITAJA_API_URL,              // optional, defaults to https://api.getitaja.com/api/v1
  catalog: [messages, exportCsv, free, pro],
});
```

The three options are read from these environment variables when you leave them
out, so `createItaja({ catalog })` works the same once they are set.

Your ids (`"app"`, `"messages"`) are yours and are typed as literals. A plan has
no id: its **name** (`"Pro"`) is its identity in its group, compared
case-insensitively (`"Pro"` and `" pro "` are the same plan), and Itaja assigns
its system id. Rename a plan and you declare a new one; the old one is archived.
Products, credit packs and licences keep their `id`. Amounts
are in **major units** (`5000` XOF, `9.99` EUR), as in the API. Mistakes the API
would refuse — an undeclared feature, two default plans, a paid plan without a
price — fail as soon as the file loads.

### 2. Push it

```bash
npx itaja push                  # shows the diff, asks, applies
```

`push` uses the `apiKey` of your `itaja.config.ts`. Run it again: nothing changes. Change a price and a **new version** of the plan
is created; running subscriptions keep theirs. Whatever you remove is archived,
never deleted, and products made in the dashboard are never touched.

| Command | Does |
|---|---|
| `npx itaja status` | lists what differs, exits 1 if anything does |
| `npx itaja push --yes` | applies without asking (CI, deploy pipeline) |
| `npx itaja catalog` | prints the JSON your code declares |

The key's prefix picks the mode: `itjs_` is sandbox, `itjp_` is live.

### 3. Mount the webhook

One route receives Itaja's events. It checks the signature, ignores a delivery it
already handled, ignores events of the other mode, and answers `500` when your
handler throws so Itaja delivers again.

```ts
// Next.js — app/itaja/webhook/route.ts
import { itaja } from "@/itaja.config";
export const POST = itaja.handler;

// Hono, Bun, Elysia, Workers
app.post("/itaja/webhook", (c) => itaja.handler(c.req.raw));

// Express — raw body on this path
app.post("/itaja/webhook", express.raw({ type: "*/*" }), itaja.nodeHandler);
```

The route checks deliveries with `webhookSecret`, the signing secret of the
endpoint in the dashboard.

### 4. React to events

```ts
export const itaja = createItaja({
  apiKey: process.env.ITAJA_API_KEY,
  webhookSecret: process.env.ITAJA_WEBHOOK_SECRET,
  catalog: [messages, exportCsv, free, pro],
  on: {
    "checkout.paid": ({ data }) => fulfil(data.checkoutId),
    "subscription.past_due": ({ data }) => warnCustomer(data),
    "subscription.canceled": ({ data }) => downgrade(data),
  },
});
```

`data` is typed per event. The `"*"` handler receives every delivery, including
types this version does not know yet. Test a handler locally with a signed sample:

```bash
npx itaja trigger checkout.paid --url http://localhost:3000/itaja/webhook   # signs with ITAJA_WEBHOOK_SECRET from .env
```

## What you can sell

| Mode | Declare with | Good for |
|---|---|---|
| [Subscriptions](#subscriptions) | `feature` · `group` · `plan` | SaaS, memberships |
| [Credits](#credits) | `credits` · `creditPack` | usage, AI tokens, coins |
| [Licence keys](#licence-keys) | `license` | desktop or mobile software |
| [One-off payments](#one-off-payments) | `itaja.checkout.create` | a physical or digital order |

Each one can live in the same `catalog` array.

### Subscriptions

The example above is the whole declaration. Around it:

```ts
const team = plan({
  name: "Team",
  group: app,
  price: { amount: 15000, currency: "XOF", interval: "month" },
  includes: [messages({ limit: 20000, reset: "month" }), exportCsv()],
});
```

- `interval`: `week` · `month` · `quarter` · `year`. `reset` on a quota is `day` · `week` · `month` · `year`.
- A plan without a `price` must be `default: true`; a group has at most one default.
- `trial: { days }` gives a free period before the first charge.

```ts
await itaja.subscriptions.list({ customerId });
await itaja.subscriptions.cancel(subscriptionId); // at period end
```

Events: `invoice.paid` · `invoice.payment_failed` · `subscription.past_due` · `subscription.canceled`.

> **Coming with the API:** `subscribe()` (new, upgrade, downgrade, cancel-to-free
> in one call), `check()` and `report()` for entitlements are typed and throw
> `NOT_YET_AVAILABLE` until the API serves them
> ([itaja-services #465, #466](https://github.com/itaja/itaja-services/issues/465)).

### Credits

A currency your app spends as the customer uses it, sold in packs.

```ts
import { creditPack, credits } from "@itaja/node";

const tokens = credits({ id: "tokens", name: "AI tokens", coinName: "Tokens" });

const small = creditPack({ id: "small", of: tokens, credits: 100, price: { amount: 1000, currency: "XOF" } });
const large = creditPack({ id: "large", of: tokens, credits: 1000, price: { amount: 8000, currency: "XOF" } });
```

```ts
const { checkoutUrl } = await itaja.credits.buy({
  product: "tokens",
  pack: "small",
  customerId,
  homeUrl,
  successUrl: "https://shop.example/credits/thanks", // optional, as on checkout.create
});
await itaja.credits.consume({ product: "tokens", customerId, amount: 3 });
await itaja.credits.balance({ product: "tokens", customerId });
```

Events: `credits.granted` · `credits.consumed` · `credits.expired` · `credits.low` · `credits.clawed_back`.

### Licence keys

Software that unlocks on a number of devices.

```ts
import { license } from "@itaja/node";

const desktop = license({
  id: "desktop",
  name: "Desktop app",
  devices: 3, // null = unlimited
  duration: "days-365", // "lifetime" · "days-N" · "from-first-activation-days-N"
  price: { amount: 25000, currency: "XOF" },
});
```

```ts
await itaja.licenses.issue({ product: "desktop", customerId });
await itaja.licenses.revoke({ product: "desktop", keyId, reason: "chargeback" });
```

Events: `license.issued` · `activated` · `deactivated` · `revoked` · `expired` · `rotated` · `suspended` · `resumed` · `updated`.

### One-off payments

Nothing to declare: create a checkout for an amount, send the customer to
`checkoutUrl`, and fulfil on `checkout.paid`.

```ts
const { checkoutUrl } = await itaja.checkout.create({
  homeUrl: "https://shop.example/thanks",
  successUrl: "https://shop.example/order/paid", // optional
  cancelUrl: "https://shop.example/cart",        // optional
  currency: "XOF",
  lineItems: [{ name: "Sandals", quantity: 1, unitPrice: 5000 }],
});
```

The payer comes back to `homeUrl` by default. Pass `successUrl`, `failureUrl`
and/or `cancelUrl` (optional, absolute `https`, on a live key a domain verified
for your account) to send each outcome to its own page; one left out keeps
Itaja's return page. Itaja adds `itaja_checkout_id` and `itaja_status`
(`success | failure | cancel`) to the address. The redirect is payer-visible:
confirm payment from the webhook, never from it.

Payment links are a dashboard feature: no builder or endpoint here creates one.

## Also in the SDK

```ts
await itaja.customers.get("user_42"); // your own customer id works too
await itaja.request("GET", "/me");    // any endpoint the helpers do not cover
```

A product made in the dashboard can be named by its Itaja id:
`{ productId: "prd_…" }`.

Verify a delivery yourself, without the handler:

```ts
import { constructEvent } from "@itaja/node";
const event = constructEvent({ payload: rawBody, headers, secret: process.env.ITAJA_WEBHOOK_SECRET! });
// the same secret you pass to createItaja
```

Behind several instances, share the processed-delivery store (it is in memory by default):

```ts
createItaja({
  …,
  dedupe: {
    has: (id) => redis.exists(`itaja:${id}`).then(Boolean),
    add: (id) => redis.set(`itaja:${id}`, 1, "EX", 86400),
  },
});
```

## Errors and retries

Every failure is an `ItajaError` with a stable `code`, the HTTP `status` and the
API's `details`: `ItajaValidationError` (400/422), `ItajaAuthenticationError`
(401), `ItajaPermissionError` (403), `ItajaNotFoundError` (404),
`ItajaConflictError` (409), `ItajaRateLimitError` (429), `ItajaServerError`
(5xx), `ItajaConnectionError`, `ItajaSignatureError`, `ItajaConfigError`. No
error ever contains your key.

Every write carries an `Idempotency-Key`, one per call and reused on its
retries, so a retried write never runs twice. Network errors, `5xx`, `429` and
`409 IDEMPOTENCY_KEY_IN_PROGRESS` are retried twice, honouring `Retry-After`.
Pass `{ idempotencyKey }` (an order id, say) to make **your own** retries safe too.

## Configuration

Every option of `createItaja`, and the variable it falls back to:

| Option | Environment | Default |
|---|---|---|
| `apiKey` | `ITAJA_API_KEY` | — |
| `webhookSecret` | `ITAJA_WEBHOOK_SECRET` | — (only the handler needs it) |
| `baseUrl` | `ITAJA_API_URL` | `https://api.getitaja.com/api/v1` |
| `timeoutMs` / `maxRetries` | — | `30000` / `2` |

There is no `environment` option: the key's prefix decides sandbox or live.

## Development

```bash
pnpm install
pnpm test        # unit + contract suites, no network
pnpm test:e2e    # against a real developer API: ITAJA_E2E_API_KEY=itjs_… ITAJA_E2E_API_URL=…
pnpm generate    # regenerate src/generated/openapi.ts from spec/openapi.json
```

`spec/openapi.json` and `spec/catalog.schema.json` (repository root) are copies of
the developer API's exported documents. `spec/signature-vectors.json` was signed
by the API's own `signOutboundWebhook`. The e2e suite writes
`tests/e2e/__fixtures__/catalog-push-walk.json` and compares every later run with it.

## License

MIT
