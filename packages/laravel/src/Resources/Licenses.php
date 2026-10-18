<?php

namespace Itaja\Laravel\Resources;

use Closure;
use Itaja\Laravel\Http\Transport;

final class Licenses
{
    /** @param  Closure(?string, ?string): string  $resolve  catalogue id / Itaja id → Itaja product id */
    public function __construct(private readonly Transport $http, private readonly Closure $resolve)
    {
    }

    /** @return array<string, mixed> */
    public function issue(?string $product = null, ?string $productId = null, ?string $customerId = null, ?int $activationsMax = null, ?string $expiresAt = null, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', $this->path($product, $productId), null, array_filter([
            'customerId' => $customerId,
            'activationsMax' => $activationsMax,
            'expiresAt' => $expiresAt,
        ], fn ($v) => $v !== null), $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function list(?string $product = null, ?string $productId = null, ?int $limit = null, ?string $cursor = null): array
    {
        return $this->http->request('GET', $this->path($product, $productId), ['limit' => $limit, 'cursor' => $cursor]);
    }

    /** @return array<string, mixed> */
    public function get(string $keyId, ?string $product = null, ?string $productId = null): array
    {
        return $this->http->request('GET', $this->path($product, $productId, $keyId));
    }

    /** @return array<string, mixed> */
    public function revoke(string $keyId, ?string $product = null, ?string $productId = null, ?string $reason = null, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', $this->path($product, $productId, $keyId, '/revoke'), null, ['reason' => $reason], $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function suspend(string $keyId, ?string $product = null, ?string $productId = null, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', $this->path($product, $productId, $keyId, '/suspend'), null, null, $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function resume(string $keyId, ?string $product = null, ?string $productId = null, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', $this->path($product, $productId, $keyId, '/resume'), null, null, $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function rotate(string $keyId, ?string $product = null, ?string $productId = null, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', $this->path($product, $productId, $keyId, '/rotate'), null, null, $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function resend(string $keyId, ?string $product = null, ?string $productId = null, ?string $idempotencyKey = null): array
    {
        return $this->http->request('POST', $this->path($product, $productId, $keyId, '/resend'), null, null, $idempotencyKey);
    }

    private function path(?string $product, ?string $productId, ?string $keyId = null, string $tail = ''): string
    {
        $base = '/products/'.rawurlencode(($this->resolve)($product, $productId)).'/licenses';

        return $base.($keyId !== null ? '/'.rawurlencode($keyId) : '').$tail;
    }
}
