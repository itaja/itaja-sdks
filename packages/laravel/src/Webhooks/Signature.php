<?php

namespace Itaja\Laravel\Webhooks;

use Itaja\Laravel\Exceptions\SignatureException;

/**
 * Itaja signs each delivery:
 *
 *     x-itaja-timestamp: <unix seconds>
 *     x-itaja-signature: v1,<base64 HMAC-SHA256(secret, "<timestamp>.<raw body>")>[,<more>]
 *
 * Several signatures may follow `v1,` while a secret is rotated: one match is
 * enough. The check runs on the RAW body, in constant time, and refuses a
 * timestamp more than `$tolerance` seconds from now.
 */
final class Signature
{
    public const SIGNATURE_HEADER = 'x-itaja-signature';

    public const TIMESTAMP_HEADER = 'x-itaja-timestamp';

    public const VERSION = 'v1';

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
        $signature = self::header($headers, self::SIGNATURE_HEADER);
        $timestamp = self::header($headers, self::TIMESTAMP_HEADER);

        if ($secret === '') {
            throw self::fail('No webhook secret. Set ITAJA_WEBHOOK_SECRET.', 'WEBHOOK_SECRET_MISSING');
        }
        if ($signature === null || $timestamp === null) {
            throw self::fail('Missing x-itaja-signature or x-itaja-timestamp header.', 'SIGNATURE_MISSING');
        }
        if (preg_match('/^\d+$/', $timestamp) !== 1) {
            throw self::fail('x-itaja-timestamp is not a unix time.', 'TIMESTAMP_INVALID');
        }
        if (abs(($now ?? time()) - (int) $timestamp) > $tolerance) {
            throw self::fail("Webhook timestamp is more than {$tolerance}s away from now.", 'TIMESTAMP_OUT_OF_TOLERANCE');
        }

        $parts = array_map('trim', explode(',', $signature));
        $version = array_shift($parts);
        if ($version !== self::VERSION || $parts === []) {
            throw self::fail('Unsupported signature scheme.', 'SIGNATURE_SCHEME_UNSUPPORTED');
        }

        $expected = hash_hmac('sha256', $timestamp.'.'.$payload, $secret, true);
        $match = false;
        foreach ($parts as $candidate) {
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
     * Signs a payload the way Itaja does, for your tests. Returns the two headers to send.
     *
     * @return array<string, string>
     */
    public static function sign(string $payload, string $secret, ?int $timestamp = null): array
    {
        $timestamp = (string) ($timestamp ?? time());

        return [
            self::SIGNATURE_HEADER => self::VERSION.','.base64_encode(hash_hmac('sha256', $timestamp.'.'.$payload, $secret, true)),
            self::TIMESTAMP_HEADER => $timestamp,
        ];
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
