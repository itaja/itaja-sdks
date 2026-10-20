# itaja/itaja-laravel

Sell subscriptions, credits and licence keys from your Laravel app. Declare what
you sell in PHP, push it to Itaja, and receive Itaja's webhooks as Laravel events.

```bash
composer require itaja/itaja-laravel
```

Requires PHP 8.2+ and Laravel 12 or 13. The package registers itself.

> **Server only.** It holds your secret API key. Never expose it to a browser or a mobile app.

## Quick start

### 1. Declare what you sell

A free plan and a paid plan, with a quota that depends on the plan. Create
`itaja.php` at the root of your project; it returns the list of what you sell.

```php
<?php // itaja.php

use Itaja\Laravel\Catalog\{Feature, Group, Plan};

// What the customer can do
$messages = Feature::metered('messages');
$export = Feature::boolean('export');

// One customer holds one plan of a group
$app = Group::make('app', 'My App');

return [
    $messages,
    $export,

    Plan::make('free', $app,
        default: true, // everyone starts here, no payment
        includes: [$messages(limit: 100, reset: 'month')],
    ),

    Plan::make('pro', $app,
        price: ['amount' => 5000, 'currency' => 'XOF', 'interval' => 'month'],
        trialDays: 7,
        includes: [$messages(limit: 2000, reset: 'month'), $export()],
    ),
];
```

Your ids (`'pro'`, `'messages'`) are yours. Amounts are in **major units**
(`5000` XOF, `9.99` EUR), as in the API. Mistakes the API would refuse — an
undeclared feature, two default plans, a paid plan without a price, an invalid id —
throw a `ConfigException` as soon as the file loads.

### 2. Push it

```env
ITAJA_API_KEY=itjs_…              # sandbox key; an itjp_… key writes the live catalogue
ITAJA_WEBHOOK_SECRET=whsec_…      # signing secret of your webhook endpoint (dashboard)
ITAJA_API_URL=https://api.getitaja.com/api/v1   # optional
```

`config/itaja.php` reads these three variables. To use another key, secret or API
URL in code — a second Itaja account, a tenant, a test:

```php
$tenant = Itaja::with(apiKey: $shop->itaja_key, baseUrl: 'https://…/api/v1');
$tenant->customers()->get('user_42');
```

```bash
php artisan itaja:push              # shows the diff, asks, applies
```

Run it again: nothing changes. Change a price and a **new version** of the plan is
created; running subscriptions keep theirs. Whatever you remove is archived, never
deleted, and products made in the dashboard are never touched.

| Command | Does |
|---|---|
| `php artisan itaja:status` | lists what differs, exits 1 if anything does |
| `php artisan itaja:push --force` | applies without asking (CI, deploy pipeline) |
| `php artisan itaja:push --dry-run` | shows the diff, writes nothing |

The key's prefix picks the mode: `itjs_` is sandbox, `itjp_` is live.

### 3. The webhook is already mounted

`POST /itaja/webhook` exists as soon as the package is installed. It checks the
signature on the raw body, ignores a delivery it already handled, ignores events of
the other mode, and answers `500` when a listener throws so Itaja delivers again.

Laravel's CSRF protection is lifted on that one route. To mount it yourself, set
`itaja.webhook.path` to `null` and point a route at `Itaja\Laravel\Http\WebhookController`.

### 4. React to events

Every delivery is dispatched as a Laravel event, one class per type. Laravel
discovers listeners on its own:

```php
// app/Listeners/Fulfil.php
use Itaja\Laravel\Events\CheckoutPaid;

class Fulfil
{
    public function handle(CheckoutPaid $event): void
    {
        Order::fulfil($event->data['checkoutId']);
    }
}
```

`$event->data` holds the fields Itaja documents for that type. Listen to
`Itaja\Laravel\Events\ItajaEvent` to receive **every** delivery, including types this
version does not know yet.

Test a listener locally with a signed sample:

```bash
php artisan itaja:trigger checkout.paid
```

## What you can sell

| Mode | Declare with | Good for |
|---|---|---|
| [Subscriptions](#subscriptions) | `Feature` · `Group` · `Plan` | SaaS, memberships |
| [Credits](#credits) | `Credits` · `CreditPack` | usage, AI tokens, coins |
| [Licence keys](#licence-keys) | `License` | desktop or mobile software |
| [One-off payments](#one-off-payments) | `Itaja::checkout()->create()` | a physical or digital order |

Each one can live in the same `itaja.php`.

### Subscriptions

The example above is the whole declaration. Around it:

```php
Plan::make('team', $app,
    price: ['amount' => 15000, 'currency' => 'XOF', 'interval' => 'month'],
    includes: [$messages(limit: 20000, reset: 'month'), $export()],
);
```

- `interval`: `week` · `month` · `quarter` · `year`. `reset` on a quota: `day` · `week` · `month` · `year`.
- A plan without a `price` must be `default: true`; a group has at most one default.
- `trialDays` gives a free period before the first charge.

```php
use Itaja\Laravel\Facades\Itaja;

Itaja::subscriptions()->list(['customerId' => $id]);
Itaja::subscriptions()->cancel($subscriptionId); // at period end
```

Events: `InvoicePaid` · `InvoicePaymentFailed` · `SubscriptionPastDue` · `SubscriptionCanceled`.

> **Coming with the API:** `Itaja::subscribe()` (new, upgrade, downgrade, cancel-to-free
> in one call), `check()` and `report()` for entitlements exist and throw
> `NOT_YET_AVAILABLE` until the API serves them
> ([itaja-services #465, #466](https://github.com/itaja/itaja-services/issues/465)).

### Credits

A currency your app spends as the customer uses it, sold in packs.

```php
use Itaja\Laravel\Catalog\{CreditPack, Credits};

$tokens = Credits::make('tokens', 'AI tokens', coinName: 'Tokens');

return [
    CreditPack::make('small', $tokens, 100, ['amount' => 1000, 'currency' => 'XOF']),
    CreditPack::make('large', $tokens, 1000, ['amount' => 8000, 'currency' => 'XOF']),
];
```

```php
$checkout = Itaja::credits()->buy(
    pack: 'small',
    customerId: $id,
    homeUrl: url('/thanks'),
    product: 'tokens',
    successUrl: url('/credits/thanks'), // optional, as on checkout()->create()
);
redirect($checkout['checkoutUrl']);

Itaja::credits()->consume(customerId: $id, amount: 3, product: 'tokens');
Itaja::credits()->balance(customerId: $id, product: 'tokens');
```

Events: `CreditsGranted` · `CreditsConsumed` · `CreditsExpired` · `CreditsLow` · `CreditsClawedBack`.

### Licence keys

Software that unlocks on a number of devices.

```php
use Itaja\Laravel\Catalog\License;

License::make('desktop', 'Desktop app',
    price: ['amount' => 25000, 'currency' => 'XOF'],
    devices: 3,                // null = unlimited
    duration: 'days-365',      // 'lifetime' · 'days-N' · 'from-first-activation-days-N'
);
```

```php
Itaja::licenses()->issue(product: 'desktop', customerId: $id);
Itaja::licenses()->revoke(keyId: $keyId, product: 'desktop', reason: 'chargeback');
```

Events: `LicenseIssued` · `LicenseActivated` · `LicenseDeactivated` · `LicenseRevoked` ·
`LicenseExpired` · `LicenseRotated` · `LicenseSuspended` · `LicenseResumed` · `LicenseUpdated`.

### One-off payments

Nothing to declare: create a checkout for an amount, send the customer to
`checkoutUrl`, and fulfil on `CheckoutPaid`.

```php
$checkout = Itaja::checkout()->create([
    'homeUrl' => url('/thanks'),
    'successUrl' => url('/order/paid'), // optional
    'cancelUrl' => url('/cart'),        // optional
    'currency' => 'XOF',
    'lineItems' => [['name' => 'Sandals', 'quantity' => 1, 'unitPrice' => 5000]],
]);
```

The payer comes back to `homeUrl` by default. Pass `successUrl`, `failureUrl`
and/or `cancelUrl` (optional, absolute `https`, on a live key a domain verified
for your account) to send each outcome to its own page; one left out keeps
Itaja's return page. Itaja adds `itaja_checkout_id` and `itaja_status`
(`success | failure | cancel`) to the address. The redirect is payer-visible:
confirm payment from the `CheckoutPaid` event, never from it.

Payment links are a dashboard feature: no class or endpoint here creates one.

## Also in the package

```php
Itaja::customers()->get('user_42');          // your own customer id works too
Itaja::request('GET', '/me');                // any endpoint the helpers do not cover
```

A product made in the dashboard is named by its Itaja id: `productId: 'prd_…'`.

Verify a delivery yourself, without the route:

```php
use Itaja\Laravel\Webhooks\Signature;

$event = Signature::verify($request->getContent(), $request->headers->all(), config('itaja.webhook_secret'));
```

Behind several servers, point `ITAJA_DEDUPE_STORE` at a shared cache store (Redis,
database): processed event ids are kept there for 24 hours.

## Errors and retries

Every failure is an `Itaja\Laravel\Exceptions\ItajaException` with a stable `errorCode`,
the HTTP `status` and the API's `details`: `ValidationException` (400/422),
`AuthenticationException` (401), `PermissionException` (403), `NotFoundException` (404),
`ConflictException` (409), `RateLimitException` (429), `ServerException` (5xx),
`ConnectionException`, `SignatureException`, `ConfigException`. No exception ever
contains your key.

Every write carries an `Idempotency-Key`, one per call and reused on its retries, so a
retried write never runs twice. Network errors, `5xx`, `429` and
`409 IDEMPOTENCY_KEY_IN_PROGRESS` are retried twice, honouring `Retry-After`. Pass
`idempotencyKey:` (an order id, say) to make **your own** retries safe too.

## Configuration

`php artisan vendor:publish --tag=itaja-config` copies `config/itaja.php`.

| Key | Environment | Default |
|---|---|---|
| `api_key` | `ITAJA_API_KEY` | — |
| `webhook_secret` | `ITAJA_WEBHOOK_SECRET` | — |
| `base_url` | `ITAJA_API_URL` | `https://api.getitaja.com/api/v1` |
| `catalog` | — | `base_path('itaja.php')` |
| `webhook.path` | — | `itaja/webhook` (`null` to mount it yourself) |
| `webhook.dedupe_store` | `ITAJA_DEDUPE_STORE` | the default cache store |
| `timeout` / `retries` | — | `30` / `2` |

There is no `environment` option: the key's prefix decides sandbox or live.

## Development

```bash
composer install   # from the repository root: its composer.json is the package's
composer test
```

`spec/catalog.schema.json` and `spec/signature-vectors.json` (repository root) are shared
with every Itaja SDK: this package builds, field for field, the catalogue the TypeScript SDK
builds (`spec/conformance/reference-catalog.json`), and accepts every webhook the backend's
own signer produced.

## License

MIT
