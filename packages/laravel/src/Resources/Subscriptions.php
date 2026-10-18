<?php

namespace Itaja\Laravel\Resources;

use Itaja\Laravel\Http\Transport;

final class Subscriptions
{
    public function __construct(private readonly Transport $http)
    {
    }

    /**
     * @param  array<string, scalar|null>  $query
     * @return array<string, mixed>
     */
    public function list(array $query = []): array
    {
        return $this->http->request('GET', '/subscriptions', $query);
    }

    /** @return array<string, mixed> */
    public function get(string $subscriptionId): array
    {
        return $this->http->request('GET', '/subscriptions/'.rawurlencode($subscriptionId));
    }

    /** @return array<string, mixed> */
    public function cancel(string $subscriptionId, bool $immediately = false, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', '/subscriptions/'.rawurlencode($subscriptionId).'/cancel', null, ['immediately' => $immediately] , $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function pause(string $subscriptionId, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', '/subscriptions/'.rawurlencode($subscriptionId).'/pause', null, null, $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function resume(string $subscriptionId, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', '/subscriptions/'.rawurlencode($subscriptionId).'/resume', null, null, $idempotencyKey);
    }
}
