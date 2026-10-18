<?php

namespace Itaja\Laravel\Resources;

use Itaja\Laravel\Http\Transport;

final class Customers
{
    public function __construct(private readonly Transport $http)
    {
    }

    /**
     * @param  array<string, mixed>  $input  name, email, phoneNumber, address, metadata, merchantCustomerId
     * @return array<string, mixed>
     */
    public function create(array $input, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', '/customers', null, $input, $idempotencyKey);
    }

    /**
     * `$customerId` is Itaja's id or YOUR `merchantCustomerId`.
     *
     * @return array<string, mixed>
     */
    public function get(string $customerId): array
    {
        return $this->http->request('GET', '/customers/'.rawurlencode($customerId));
    }

    /**
     * @param  array<string, mixed>  $input
     * @return array<string, mixed>
     */
    public function update(string $customerId, array $input, ?string $idempotencyKey = null): array
    {
        return $this->http->request('PATCH', '/customers/'.rawurlencode($customerId), null, $input, $idempotencyKey);
    }

    /**
     * @param  array<string, scalar|null>  $query
     * @return array<string, mixed>
     */
    public function list(array $query = []): array
    {
        return $this->http->request('GET', '/customers', $query);
    }

    /** @return array<string, mixed> */
    public function invoices(string $customerId): array
    {
        return $this->http->request('GET', '/customers/'.rawurlencode($customerId).'/invoices');
    }
}
