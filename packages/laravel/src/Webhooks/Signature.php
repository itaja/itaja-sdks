<?php

namespace Itaja\Laravel\Webhooks;

use Itaja\Laravel\Exceptions\SignatureException;

/**
 * Itaja signs with Standard Webhooks (https://www.standardwebhooks.com), and
 * with nothing else:
 *
 *     webhook-id:        <message id, the same on every retry of the event>
 *     webhook-timestamp: <unix seconds>
 *     webhook-signature: v1,<base64>[ v1,<base64>]
 *
 *     signature = base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>"))
 *
 * The key is the secret without its `whsec_` prefix, base64-decoded. A legacy
 * `whsec_<48 hex>` secret needs no rotation: hex is valid base64, so it decodes
 * to 36 bytes like in any Standard Webhooks library. A secret that is not
 * canonical base64 is used as its raw bytes, which is what the emitter does.
 *
 * Several space-separated entries arrive while a secret is rotated: one match
 * is enough, and an entry of another version than `v1` is skipped. The check
 * runs on the RAW body, in constant time, and refuses a timestamp more than
 * `$tolerance` seconds from now, in either direction.
 */
final class Signature
{
    public const ID_HEADER = 'webhook-id';

    public const TIMESTAMP_HEADER = 'webhook-timestamp';

    public const SIGNATURE_HEADER = 'webhook-signature';

    public const VERSION = 'v1';

    public const SECRET_PREFIX = 'whsec_';

    public const DEFAULT_TOLERANCE = 300;

    /**
     * Checks a delivery and returns its decoded event envelope.
     *
     * @param  array<string, string|list<string>|null>  $headers  any casing
     * @return array{id: string, type: string, data: array<string, mixed>, mode?: string, apiVersion?: string, createdAt?: string}
     *
     * @throws SignatureException
     */
    public static function verify(string $payload, array $headers, string $secret, int $tolerance = self::DEFAULT_TOLERANCE, ?int $now = null): array
    {
        $id = self::header($headers, self::ID_HEADER);
        $timestamp = self::header($headers, self::TIMESTAMP_HEADER);
        $signature = self::header($headers, self::SIGNATURE_HEADER);

        if ($secret === '') {
            throw self::fail('No webhook secret. Set ITAJA_WEBHOOK_SECRET.', 'WEBHOOK_SECRET_MISSING');
        }
        if ($id === null || $timestamp === null || $signature === null) {
            throw self::fail('Missing webhook-id, webhook-timestamp or webhook-signature header.', 'SIGNATURE_MISSING');
        }
        if (preg_match('/^[0-9]+$/D', $timestamp) !== 1) {
            throw self::fail('webhook-timestamp is not a unix time.', 'TIMESTAMP_INVALID');
        }
        if (abs(($now ?? time()) - (int) $timestamp) > $tolerance) {
            throw self::fail("Webhook timestamp is more than {$tolerance}s away from now.", 'TIMESTAMP_OUT_OF_TOLERANCE');
        }

        $candidates = self::v1Signatures($signature);
        if ($candidates === []) {
            throw self::fail('webhook-signature carries no v1,<base64> entry.', 'SIGNATURE_SCHEME_UNSUPPORTED');
        }

        $expected = self::digest($secret, $id, $timestamp, $payload);
        $match = false;
        foreach ($candidates as $candidate) {
            $given = base64_decode($candidate, true);
            // No early exit: every candidate is compared, in constant time.
            if ($given !== false && hash_equals($expected, $given)) {
                $match = true;
            }
        }
        if (! $match) {
            throw self::fail('Webhook signature does not match.', 'SIGNATURE_MISMATCH');
        }

        $event = json_decode($payload, true);
        if (! is_array($event) || ! is_string($event['id'] ?? null) || ! is_string($event['type'] ?? null) || ! is_array($event['data'] ?? null)) {
            throw self::fail('Webhook body is not an Itaja event.', 'PAYLOAD_INVALID');
        }

        return $event;
    }

    /**
     * Signs a payload the way Itaja does, for your tests and `itaja:trigger`.
     * Returns the three headers to send: `webhook-id`, `webhook-timestamp`,
     * `webhook-signature`. `$id` defaults to a fresh `msg_<random>`; a retry of
     * the same event must reuse it.
     *
     * @return array<string, string>
     */
    public static function sign(string $payload, string $secret, ?int $timestamp = null, ?string $id = null): array
    {
        $timestamp = (string) ($timestamp ?? time());
        $id ??= 'msg_'.bin2hex(random_bytes(16));

        return [
            self::ID_HEADER => $id,
            self::TIMESTAMP_HEADER => $timestamp,
            self::SIGNATURE_HEADER => self::VERSION.','.base64_encode(self::digest($secret, $id, $timestamp, $payload)),
        ];
    }

    /**
     * The HMAC key of a secret: what follows `whsec_`, base64-decoded. Text that
     * is not canonical base64 (it would not encode back to itself) is used as is
     * — the emitter derives the key the same way.
     */
    private static function key(string $secret): string
    {
        $text = str_starts_with($secret, self::SECRET_PREFIX) ? substr($secret, strlen(self::SECRET_PREFIX)) : $secret;
        if (preg_match('#^[A-Za-z0-9+/]*={0,2}$#D', $text) === 1 && strlen($text) % 4 === 0) {
            $decoded = base64_decode($text, true);
            if ($decoded !== false && $decoded !== '' && base64_encode($decoded) === $text) {
                return $decoded;
            }
        }

        return $text;
    }

    /** HMAC-SHA256 over `<id>.<timestamp>.<raw body>`: the body bytes go in untouched. */
    private static function digest(string $secret, string $id, string $timestamp, string $payload): string
    {
        return hash_hmac('sha256', $id.'.'.$timestamp.'.'.$payload, self::key($secret), true);
    }

    /**
     * The base64 part of every `v1,<base64>` entry of a space-separated header.
     *
     * @return list<string>
     */
    private static function v1Signatures(string $header): array
    {
        $signatures = [];
        foreach (preg_split('/\s+/', $header, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $entry) {
            $parts = explode(',', $entry);
            if ($parts[0] === self::VERSION && ($parts[1] ?? '') !== '') {
                $signatures[] = $parts[1];
            }
        }

        return $signatures;
    }

    /** @param  array<string, string|list<string>|null>  $headers */
    private static function header(array $headers, string $name): ?string
    {
        foreach ($headers as $key => $value) {
            if (strtolower((string) $key) !== $name) {
                continue;
            }
            $value = is_array($value) ? ($value[0] ?? null) : $value;

            return is_string($value) && $value !== '' ? $value : null;
        }

        return null;
    }

    private static function fail(string $message, string $code): SignatureException
    {
        return new SignatureException($message, $code, 400);
    }
}
