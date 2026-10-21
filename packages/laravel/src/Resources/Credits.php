<?php

namespace Itaja\Laravel\Resources;

use Closure;
use Illuminate\Support\Str;
use Itaja\Laravel\Catalog\Support;
use Itaja\Laravel\Exceptions\NotFoundException;
use Itaja\Laravel\Http\Transport;

final class Credits
{
    /** @param  Closure(string): string  $resolve  product name → Itaja product id */
    public function __construct(private readonly Transport $http, private readonly Closure $resolve)
    {
    }

    /**
     * Adds credits to a customer's balance.
     *
     * @return array<string, mixed>
     */
    public function grant(string $customerId, int $amount, string $product, ?string $reason = null, ?string $expiresAt = null, ?int $lowBalanceThreshold = null, ?string $idempotencyKey = null): array
    {
        return $this->move('grant', $product, array_filter([
            'customerId' => $customerId,
            'amount' => $amount,
            'reason' => $reason,
            'expiresAt' => $expiresAt,
            'lowBalanceThreshold' => $lowBalanceThreshold,
        ], fn ($v) => $v !== null), $idempotencyKey);
    }

    /**
     * Spends credits. Refuses, writing nothing, when the balance is short.
     *
     * @return array<string, mixed>
     */
    public function consume(string $customerId, int $amount, string $product, ?string $reason = null, ?string $idempotencyKey = null): array
    {
        return $this->move('consume', $product, array_filter([
            'customerId' => $customerId,
            'amount' => $amount,
            'reason' => $reason,
        ], fn ($v) => $v !== null), $idempotencyKey);
    }

    /** @return array<string, mixed> */
    public function balance(string $customerId, string $product): array
    {
        return $this->http->request('GET', $this->path($product)."/credits/{$this->seg($customerId)}/balance");
    }

    /** @return array<string, mixed> */
    public function wallet(string $customerId, string $product, ?int $limit = null): array
    {
        return $this->http->request('GET', $this->path($product)."/credits/{$this->seg($customerId)}", ['limit' => $limit]);
    }

    /**
     * A 15-minute token the buyer's device spends with, without your key.
     *
     * @return array<string, mixed>
     */
    public function walletToken(string $customerId, string $product): array
    {
        return $this->http->request('POST', $this->path($product)."/credits/{$this->seg($customerId)}/wallet-token");
    }

    /** @return array<string, mixed> */
    public function packs(string $product): array
    {
        return $this->http->request('GET', $this->path($product).'/credit-packs');
    }

    /**
     * Sells a declared pack, named as declared (`pack: '100 tokens'`, compared
     * trimmed and case-insensitively): returns the checkout to send the buyer to.
     * `successUrl`, `failureUrl` and `cancelUrl` are optional, as on `checkout()->create()`;
     * they come last so existing positional calls keep their meaning — name them.
     *
     * @return array<string, mixed>
     */
    public function buy(string $pack, string $customerId, string $homeUrl, string $product, ?string $reference = null, ?string $language = null, ?string $idempotencyKey = null, ?string $successUrl = null, ?string $failureUrl = null, ?string $cancelUrl = null): array
    {
        $base = $this->path($product);
        $listed = $this->http->request('GET', $base.'/credit-packs');
        $found = null;
        $wanted = Support::normalize($pack);
        foreach ((is_array($listed) ? ($listed['packs'] ?? []) : []) as $candidate) {
            $key = $candidate['catalogKey'] ?? null;
            if ($wanted !== '' && is_string($key) && Support::normalize($key) === $wanted) {
                $found = $candidate;
                break;
            }
        }
        if ($found === null) {
            throw new NotFoundException("No credit pack named \"{$pack}\" is on sale for \"{$product}\".", 'CREDIT_PACK_NOT_FOUND', 404);
        }

        return $this->http->request('POST', "{$base}/credit-packs/{$this->seg((string) $found['id'])}/checkout", null, array_filter([
            'customerId' => $customerId,
            'homeUrl' => $homeUrl,
            'successUrl' => $successUrl,
            'failureUrl' => $failureUrl,
            'cancelUrl' => $cancelUrl,
            'reference' => $reference,
            'language' => $language,
        ], fn ($v) => $v !== null), $idempotencyKey);
    }

    /**
     * Credits take their own body `idempotencyKey`: the SDK sends the same one
     * as the header's, so a retry is one movement.
     *
     * @param  array<string, mixed>  $body
     * @return array<string, mixed>
     */
    private function move(string $kind, string $product, array $body, ?string $idempotencyKey): array
    {
        $key = $idempotencyKey ?? (string) Str::uuid();

        return $this->http->request('POST', $this->path($product)."/credits/{$kind}", null, $body + ['idempotencyKey' => $key], $key);
    }

    private function path(string $product): string
    {
        return '/products/'.$this->seg(($this->resolve)($product));
    }

    private function seg(string $value): string
    {
        return rawurlencode($value);
    }
}
