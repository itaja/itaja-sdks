<?php

namespace Itaja\Laravel\Http;

use Closure;
use Illuminate\Http\Client\ConnectionException as HttpConnectionException;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Str;
use Itaja\Laravel\Exceptions\ConfigException;
use Itaja\Laravel\Exceptions\ConnectionException;
use Itaja\Laravel\Exceptions\ItajaException;

/**
 * The HTTP layer: the `{ success, data }` envelope unwrapped, typed
 * exceptions, and retries that can never charge twice.
 *
 * Retry rule: only a call that is safe to send again is retried. The SDK puts
 * an `Idempotency-Key` on EVERY write (one per logical call, reused on each
 * retry), so the API answers a retry with the first response instead of
 * running it again. Retried: no response, 5xx, 429 and
 * `409 IDEMPOTENCY_KEY_IN_PROGRESS`. `Retry-After` is honoured.
 *
 * @internal
 */
final class Transport
{
    public const DEFAULT_BASE_URL = 'https://api.getitaja.com/api/v1';

    private const RETRYABLE_CONFLICT = 'IDEMPOTENCY_KEY_IN_PROGRESS';

    private const MAX_WAIT_MS = 30_000;

    /** @var Closure(int): void */
    private Closure $sleep;

    /**
     * @param  (Closure(int): void)|null  $sleep  milliseconds; replaced in tests
     */
    public function __construct(
        private readonly Factory $http,
        private readonly string $apiKey,
        private readonly string $baseUrl = self::DEFAULT_BASE_URL,
        private readonly int $timeout = 30,
        private readonly int $maxRetries = 2,
        ?Closure $sleep = null,
    ) {
        $this->sleep = $sleep ?? static function (int $ms): void {
            usleep($ms * 1000);
        };
    }

    /** The collection mode a key acts in: the prefix decides, never an option. */
    public function mode(): string
    {
        return self::modeOfKey($this->apiKey);
    }

    public static function modeOfKey(?string $apiKey): string
    {
        return str_starts_with((string) $apiKey, 'itjs_') ? 'sandbox' : 'live';
    }

    /**
     * @param  'GET'|'POST'|'PUT'|'PATCH'|'DELETE'  $method
     * @param  array<string, scalar|null>  $query
     */
    public function request(string $method, string $path, ?array $query = null, mixed $body = null, ?string $idempotencyKey = null): mixed
    {
        if ($this->apiKey === '') {
            throw new ConfigException('No Itaja API key. Set ITAJA_API_KEY.', 'API_KEY_MISSING', 0);
        }

        $isWrite = $method !== 'GET';
        $idempotencyKey = $isWrite ? ($idempotencyKey ?? (string) Str::uuid()) : null;
        $query = $query === null ? [] : array_filter($query, static fn ($v) => $v !== null);
        $url = rtrim($this->baseUrl, '/').'/'.ltrim($path, '/');

        for ($attempt = 0; ; $attempt++) {
            try {
                $response = $this->send($method, $url, $query, $body, $idempotencyKey);
            } catch (HttpConnectionException $e) {
                if ($attempt < $this->maxRetries) {
                    ($this->sleep)($this->backoff($attempt));

                    continue;
                }
                throw new ConnectionException('Could not reach Itaja: '.$e->getMessage(), 'CONNECTION_ERROR', 0);
            }

            $status = $response->status();
            $payload = $response->json();
            $payload = is_array($payload) ? $payload : [];

            if ($status < 300 && ($payload['success'] ?? true) !== false) {
                return array_key_exists('data', $payload) ? $payload['data'] : $payload;
            }

            $retryAfter = $this->retryAfter($response);
            $retryable = $status >= 500 || $status === 429
                || ($status === 409 && ($payload['code'] ?? null) === self::RETRYABLE_CONFLICT);
            if ($retryable && $attempt < $this->maxRetries) {
                ($this->sleep)($retryAfter !== null ? min($retryAfter * 1000, self::MAX_WAIT_MS) : $this->backoff($attempt));

                continue;
            }

            $details = $payload['details'] ?? null;
            throw ItajaException::forStatus(
                $status,
                is_string($payload['error'] ?? null) ? $payload['error'] : "Itaja answered HTTP {$status}",
                is_string($payload['code'] ?? null) ? $payload['code'] : "HTTP_{$status}",
                $response->header('x-request-id') ?: null,
                is_array($details) ? $details : null,
                $retryAfter,
            );
        }
    }

    /** @param  array<string, scalar> $query */
    private function send(string $method, string $url, array $query, mixed $body, ?string $idempotencyKey): Response
    {
        $pending = $this->http
            ->withHeaders(array_filter([
                'x-itj-key' => $this->apiKey,
                'x-itaja-client' => 'itaja-laravel/'.\Itaja\Laravel\Version::SDK,
                'Idempotency-Key' => $idempotencyKey,
            ]))
            ->acceptJson()
            // Every status is read here (Laravel never throws unless asked): the envelope decides.
            ->timeout($this->timeout);
        if ($body !== null) {
            $pending = $pending->asJson();
        }

        return $pending->send($method, $url, array_filter([
            'query' => $query ?: null,
            'json' => $body,
        ], static fn ($v) => $v !== null));
    }

    private function backoff(int $attempt): int
    {
        return min(500 * (2 ** $attempt) + random_int(0, 250), self::MAX_WAIT_MS);
    }

    private function retryAfter(Response $response): ?int
    {
        $value = $response->header('retry-after');
        if ($value === '' || $value === null) {
            return null;
        }
        if (is_numeric($value) && (float) $value >= 0) {
            return (int) ceil((float) $value);
        }
        $date = strtotime($value);

        return $date === false ? null : max(0, $date - time());
    }
}
