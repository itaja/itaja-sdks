# itaja

Sell subscriptions, credits and licence keys from your Python server. Declare what
you sell in code, push it to Itaja, mount one webhook route (Django, FastAPI,
Starlette, Flask), react to typed events.

```bash
pip install itaja          # uv add itaja · poetry add itaja
```

Requires Python 3.10+.

> **Server only.** This package holds your secret API key. Never ship it to a
> browser or a mobile app.

## Quick start

### 0. Configure

Put your keys in `.env` (never commit it) and pass them to `create_itaja`:

```bash
# .env
ITAJA_API_KEY=itjs_…              # sandbox key; an itjp_… key works on the live catalogue
ITAJA_WEBHOOK_SECRET=whsec_…      # signing secret of your webhook endpoint (dashboard)
ITAJA_API_URL=https://api.getitaja.com/api/v1   # optional
```

```python
import os
from itaja import create_itaja

itaja = create_itaja(
    api_key=os.environ["ITAJA_API_KEY"],
    webhook_secret=os.environ["ITAJA_WEBHOOK_SECRET"],
    base_url=os.environ.get("ITAJA_API_URL"),
    catalog=[...],
)
```

Each argument falls back to its variable when you leave it out. Pass other values
to use another account, a tenant's key or a staging API. The `itaja` command loads
`.env` and `.env.local` itself: nothing to export in your shell. In your app, load
`.env` the way you already do (django-environ, pydantic-settings, python-dotenv…).

### 1. Declare what you sell

A free plan and a paid plan, with a quota that depends on the plan.

```python
# itaja_config.py
import os
from itaja import create_itaja, feature, group, plan

# What the customer can do
messages = feature("messages", "metered")
export = feature("export", "boolean")

# One customer holds one plan of a group
app = group("app", "My App")

free = plan(
    "free", app,
    default=True,  # everyone starts here, no payment
    includes=[messages(limit=100, reset="month")],
)

pro = plan(
    "pro", app,
    price={"amount": 5000, "currency": "XOF", "interval": "month"},
    trial_days=7,
    includes=[messages(limit=2000, reset="month"), export()],
)

itaja = create_itaja(
    api_key=os.environ.get("ITAJA_API_KEY"),
    webhook_secret=os.environ.get("ITAJA_WEBHOOK_SECRET"),
    catalog=[messages, export, free, pro],
)
```

Your ids (`"pro"`, `"messages"`) are yours. Amounts are in **major units**
(`5000` XOF, `9.99` EUR), as in the API. Mistakes the API would refuse — an
undeclared feature, two default plans, a paid plan without a price, an invalid
id — raise `ItajaConfigError` as soon as the module is imported.

### 2. Push it

```bash
itaja push                  # shows the diff, asks, applies
```

`push` uses the `api_key` of the client in `itaja_config.py`. Run it again: nothing
changes. Change a price and a **new version** of the plan is created; running
subscriptions keep theirs. Whatever you remove is archived, never deleted, and
products made in the dashboard are never touched.

| Command | Does |
|---|---|
| `itaja status` | lists what differs, exits 1 if anything does |
| `itaja push --yes` | applies without asking (CI, deploy pipeline) |
| `itaja catalog` | prints the JSON your code declares |
| `itaja --config myapp.billing:itaja push` | your client lives elsewhere |

The key's prefix picks the mode: `itjs_` is sandbox, `itjp_` is live.

### 3. Mount the webhook

One route receives Itaja's events. It checks the signature on the raw body,
ignores a delivery it already handled, ignores events of the other mode, and
answers `500` when your handler raises so Itaja delivers again. It checks
deliveries with `webhook_secret`.

**Django** (`pip install "itaja[django]"`)

```python
# urls.py
from django.urls import path
from itaja.integrations.django import webhook_view
from itaja_config import itaja

urlpatterns = [path("itaja/webhook", webhook_view(itaja))]  # CSRF-exempt, POST only
```

**FastAPI** (`pip install "itaja[fastapi]"`)

```python
from fastapi import FastAPI
from itaja.integrations.starlette import webhook_router
from itaja_config import itaja

app = FastAPI()
app.include_router(webhook_router(itaja))  # POST /itaja/webhook
```

**Starlette**: `Route("/itaja/webhook", webhook_endpoint(itaja), methods=["POST"])`
from `itaja.integrations.starlette`.

**Flask** (`pip install "itaja[flask]"`)

```python
from flask import Flask
from itaja.integrations.flask import webhook_blueprint
from itaja_config import itaja

app = Flask(__name__)
app.register_blueprint(webhook_blueprint(itaja))  # POST /itaja/webhook
```

Anything else: `itaja.webhooks.process(raw_body, headers)` (or `await
itaja.webhooks.process_async(...)`) returns the status and body to answer.

### 4. React to events

```python
@itaja.on("checkout.paid")
def fulfil(event):
    Order.fulfil(event.data["checkoutId"])

@itaja.on("subscription.canceled")
async def downgrade(event):        # async handlers work too
    await accounts.downgrade(event.data["customerId"])
```

Or pass them at creation: `create_itaja(..., on={"checkout.paid": fulfil})`.
`event.data` holds the fields Itaja documents for that type. The `"*"` handler
receives every delivery, including types this version does not know yet.

Test a handler locally with a signed sample:

```bash
itaja trigger checkout.paid --url http://localhost:8000/itaja/webhook   # signs with ITAJA_WEBHOOK_SECRET from .env
```

## What you can sell

| Mode | Declare with | Good for |
|---|---|---|
| [Subscriptions](#subscriptions) | `feature` · `group` · `plan` | SaaS, memberships |
| [Credits](#credits) | `credits` · `credit_pack` | usage, AI tokens, coins |
| [Licence keys](#licence-keys) | `license` | desktop or mobile software |
| [One-off payments](#one-off-payments) | `itaja.checkout.create` | a physical or digital order |

Each one can live in the same `catalog` list.

### Subscriptions

The example above is the whole declaration. Around it:

```python
team = plan(
    "team", app,
    price={"amount": 15000, "currency": "XOF", "interval": "month"},
    includes=[messages(limit=20000, reset="month"), export()],
)
```

- `interval`: `week` · `month` · `quarter` · `year`. `reset` on a quota: `day` · `week` · `month` · `year`.
- A plan without a `price` must be `default=True`; a group has at most one default.
- `trial_days` gives a free period before the first charge.

```python
itaja.subscriptions.list(customerId=customer_id)
itaja.subscriptions.cancel(subscription_id)  # at period end
```

Events: `invoice.paid` · `invoice.payment_failed` · `subscription.past_due` · `subscription.canceled`.

> **Coming with the API:** `itaja.subscribe()` (new, upgrade, downgrade,
> cancel-to-free in one call), `check()` and `report()` for entitlements exist and
> raise `NOT_YET_AVAILABLE` until the API serves them
> ([itaja-services #465, #466](https://github.com/itaja/itaja-services/issues/465)).

### Credits

A currency your app spends as the customer uses it, sold in packs.

```python
from itaja import credit_pack, credits

tokens = credits("tokens", "AI tokens", coin_name="Tokens")

small = credit_pack("small", tokens, 100, {"amount": 1000, "currency": "XOF"})
large = credit_pack("large", tokens, 1000, {"amount": 8000, "currency": "XOF"})
```

```python
checkout = itaja.credits.buy(pack="small", customer_id=customer_id, home_url="https://shop.example/thanks", product="tokens")
# redirect the buyer to checkout["checkoutUrl"]

itaja.credits.consume(customer_id=customer_id, amount=3, product="tokens")
itaja.credits.balance(customer_id=customer_id, product="tokens")
```

Events: `credits.granted` · `credits.consumed` · `credits.expired` · `credits.low` · `credits.clawed_back`.

### Licence keys

Software that unlocks on a number of devices.

```python
from itaja import license

desktop = license(
    "desktop", "Desktop app",
    price={"amount": 25000, "currency": "XOF"},
    devices=3,             # None = unlimited
    duration="days-365",   # "lifetime" · "days-N" · "from-first-activation-days-N"
)
```

```python
itaja.licenses.issue(product="desktop", customer_id=customer_id)
itaja.licenses.revoke(key_id, product="desktop", reason="chargeback")
```

Events: `license.issued` · `activated` · `deactivated` · `revoked` · `expired` · `rotated` · `suspended` · `resumed` · `updated`.

### One-off payments

Nothing to declare: create a checkout for an amount, send the customer to
`checkoutUrl`, and fulfil on `checkout.paid`.

```python
checkout = itaja.checkout.create(
    homeUrl="https://shop.example/thanks",
    currency="XOF",
    lineItems=[{"name": "Sandals", "quantity": 1, "unitPrice": 5000}],
)
```

Payment links are a dashboard feature: no builder or endpoint here creates one.

## Also in the SDK

```python
itaja.customers.get("user_42")   # your own customer id works too
itaja.request("GET", "/me")      # any endpoint the helpers do not cover
```

A product made in the dashboard is named by its Itaja id: `product_id="prd_…"`.

Verify a delivery yourself, without the route:

```python
from itaja import construct_event

event = construct_event(raw_body, headers, secret=os.environ["ITAJA_WEBHOOK_SECRET"])
```

Behind several processes or servers, share the processed-delivery store (it is in
memory by default) with any object that has `has(event_id)` and `add(event_id)`:

```python
class RedisDedupe:
    def has(self, event_id): return bool(redis.exists(f"itaja:{event_id}"))
    def add(self, event_id): redis.set(f"itaja:{event_id}", 1, ex=86400)

itaja = create_itaja(..., dedupe=RedisDedupe())
```

## Errors and retries

Every failure is an `ItajaError` with a stable `code`, the HTTP `status` and the
API's `details`: `ItajaValidationError` (400/422), `ItajaAuthenticationError`
(401), `ItajaPermissionError` (403), `ItajaNotFoundError` (404),
`ItajaConflictError` (409), `ItajaRateLimitError` (429), `ItajaServerError`
(5xx), `ItajaConnectionError`, `ItajaSignatureError`, `ItajaConfigError`. No error
ever contains your key.

Every write carries an `Idempotency-Key`, one per call and reused on its retries,
so a retried write never runs twice. Network errors, `5xx`, `429` and
`409 IDEMPOTENCY_KEY_IN_PROGRESS` are retried twice, honouring `Retry-After`. Pass
`idempotency_key=` (an order id, say) to make **your own** retries safe too.

## Configuration

Every argument of `create_itaja`, and the variable it falls back to:

| Argument | Environment | Default |
|---|---|---|
| `api_key` | `ITAJA_API_KEY` | — |
| `webhook_secret` | `ITAJA_WEBHOOK_SECRET` | — (only the webhook route needs it) |
| `base_url` | `ITAJA_API_URL` | `https://api.getitaja.com/api/v1` |
| `timeout` / `max_retries` | — | `30` / `2` |
| `dedupe` | — | in memory, 24 h |

There is no `environment` argument: the key's prefix decides sandbox or live.

## Development

```bash
uv sync
uv run pytest
uv run mypy
uv run ruff check
```

`spec/catalog.schema.json` and `spec/signature-vectors.json` (repository root) are
shared with every Itaja SDK: this package builds, field for field, the catalogue
the TypeScript SDK builds (`spec/conformance/reference-catalog.json`), and accepts
every webhook the backend's own signer produced.

## License

MIT
