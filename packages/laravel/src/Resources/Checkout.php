<?php

namespace Itaja\Laravel\Resources;

use Itaja\Laravel\Http\Transport;

final class Checkout
{
    public function __construct(private readonly Transport $http)
    {
    }

    /**
     * A cart you price yourself. Returns the `checkoutUrl` to send the buyer to.
     * `successUrl`, `failureUrl` and `cancelUrl` (optional) are where Itaja's return
     * page sends the payer for each outcome; confirm payment from the webhook, never
     * from the redirect.
     *
     * @param  array<string, mixed>  $input  homeUrl (required), successUrl, failureUrl, cancelUrl, currency, lineItems, customer, description, language, metadata, reference
     * @return array<string, mixed>
     */
    public function create(array $input, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', '/checkout-sessions', null, $input, $idempotencyKey);
    }
}
