<?php

/**
 * Webhook verification (`x-itaja-signature` / `x-itaja-timestamp`).
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * W1. A signature Itaja's backend produced is refused (the two sides disagree
 *     on the signed content, the encoding or the header format). The vectors
 *     are signed by the backend's own `signOutboundWebhook`.
 * W2. A tampered body, a body re-serialised by a JSON parser, or a signature
 *     made with another secret is accepted.
 * W3. A delivery older (or newer) than the tolerance is accepted: a captured
 *     request replays forever.
 * W4. A missing header, a non-numeric timestamp or another scheme than `v1`
 *     throws something else than SignatureException (a 500 instead of a 400).
 * W5. During a secret rotation (`v1,<old>,<new>`) the delivery is refused.
 * W6. A signature of the wrong length or not base64 crashes instead of failing.
 */

namespace Itaja\Laravel\Tests;

use Itaja\Laravel\Exceptions\SignatureException;
use Itaja\Laravel\Webhooks\Signature;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class SignatureTest extends TestCase
{
    /** @return array{secret: string, vectors: list<array{name: string, timestamp: string, body: string, signature: string}>} */
    private static function vectors(): array
    {
        return json_decode((string) file_get_contents(__DIR__.'/../../../spec/signature-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @return iterable<string, array{array{name: string, timestamp: string, body: string, signature: string}}> */
    public static function backendVectors(): iterable
    {
        foreach (self::vectors()['vectors'] as $vector) {
            yield $vector['name'] => [$vector];
        }
    }

    /** @param  array{timestamp: string, signature: string}  $v */
    private static function headers(array $v): array
    {
        return ['x-itaja-signature' => $v['signature'], 'x-itaja-timestamp' => $v['timestamp']];
    }

    private static function secret(): string
    {
        return self::vectors()['secret'];
    }

    private function codeOf(callable $verify): string
    {
        try {
            $verify();
        } catch (SignatureException $e) {
            $this->assertSame(400, $e->status);

            return $e->errorCode;
        }

        return 'ACCEPTED';
    }

    /** @param  array{name: string, timestamp: string, body: string, signature: string}  $v */
    #[DataProvider('backendVectors')]
    public function test_w1_accepts_the_backends_own_signature(array $v): void
    {
        $event = Signature::verify($v['body'], self::headers($v), self::secret(), now: (int) $v['timestamp']);

        $this->assertSame(json_decode($v['body'], true)['id'], $event['id']);
    }

    public function test_w1_reads_headers_in_any_casing(): void
    {
        $v = self::vectors()['vectors'][0];
        $event = Signature::verify($v['body'], ['X-Itaja-Signature' => $v['signature'], 'X-ITAJA-TIMESTAMP' => $v['timestamp']], self::secret(), now: (int) $v['timestamp']);

        $this->assertSame('checkout.paid', $event['type']);
    }

    public function test_w2_refuses_a_tampered_body_a_reserialised_body_and_another_secret(): void
    {
        $v = self::vectors()['vectors'][0];
        $at = (int) $v['timestamp'];
        $verify = fn (string $body, string $secret) => fn () => Signature::verify($body, self::headers($v), $secret, now: $at);

        $this->assertSame('SIGNATURE_MISMATCH', $this->codeOf($verify(str_replace('5000', '50000', $v['body']), self::secret())));
        $this->assertSame('SIGNATURE_MISMATCH', $this->codeOf($verify((string) json_encode(json_decode($v['body'], true), JSON_PRETTY_PRINT), self::secret())));
        $this->assertSame('SIGNATURE_MISMATCH', $this->codeOf($verify($v['body'], 'whsec_other')));
    }

    public function test_w3_refuses_outside_the_five_minute_tolerance_both_ways(): void
    {
        $v = self::vectors()['vectors'][0];
        $at = (int) $v['timestamp'];
        $run = fn (int $now) => $this->codeOf(fn () => Signature::verify($v['body'], self::headers($v), self::secret(), now: $now));

        $this->assertSame('ACCEPTED', $run($at + 300));
        $this->assertSame('TIMESTAMP_OUT_OF_TOLERANCE', $run($at + 301));
        $this->assertSame('TIMESTAMP_OUT_OF_TOLERANCE', $run($at - 301));
    }

    public function test_w4_a_malformed_delivery_is_a_signature_exception_never_anything_else(): void
    {
        $v = self::vectors()['vectors'][0];
        $at = (int) $v['timestamp'];
        $check = fn (array $headers, ?string $secret = null) => $this->codeOf(fn () => Signature::verify($v['body'], $headers, $secret ?? self::secret(), now: $at));

        $this->assertSame('SIGNATURE_MISSING', $check([]));
        $this->assertSame('SIGNATURE_MISSING', $check(['x-itaja-signature' => $v['signature']]));
        $this->assertSame('TIMESTAMP_INVALID', $check(['x-itaja-signature' => $v['signature'], 'x-itaja-timestamp' => 'yesterday']));
        $this->assertSame('SIGNATURE_SCHEME_UNSUPPORTED', $check(['x-itaja-signature' => 'v2,abc', 'x-itaja-timestamp' => $v['timestamp']]));
        $this->assertSame('SIGNATURE_SCHEME_UNSUPPORTED', $check(['x-itaja-signature' => 'v1', 'x-itaja-timestamp' => $v['timestamp']]));
        $this->assertSame('WEBHOOK_SECRET_MISSING', $check(self::headers($v), ''));
    }

    public function test_w5_during_a_secret_rotation_one_matching_signature_is_enough(): void
    {
        $v = self::vectors()['vectors'][0];
        $at = (int) $v['timestamp'];
        $old = substr($v['signature'], 3);
        $stale = base64_encode(hash_hmac('sha256', $at.'.'.$v['body'], 'whsec_old', true));
        $both = fn (string ...$parts) => ['x-itaja-signature' => 'v1,'.implode(',', $parts), 'x-itaja-timestamp' => $v['timestamp']];

        $this->assertSame('ACCEPTED', $this->codeOf(fn () => Signature::verify($v['body'], $both($stale, $old), self::secret(), now: $at)));
        $this->assertSame('ACCEPTED', $this->codeOf(fn () => Signature::verify($v['body'], $both($old, $stale), self::secret(), now: $at)));
        $this->assertSame('SIGNATURE_MISMATCH', $this->codeOf(fn () => Signature::verify($v['body'], $both($stale), self::secret(), now: $at)));
    }

    public function test_w6_a_signature_that_is_not_base64_or_the_wrong_length_fails_cleanly(): void
    {
        $v = self::vectors()['vectors'][0];
        $at = (int) $v['timestamp'];
        foreach (['!!!not-base64!!!', 'AAAA', base64_encode(str_repeat('x', 64))] as $junk) {
            $this->assertSame('SIGNATURE_MISMATCH', $this->codeOf(fn () => Signature::verify($v['body'], ['x-itaja-signature' => 'v1,'.$junk, 'x-itaja-timestamp' => $v['timestamp']], self::secret(), now: $at)));
        }
    }

    public function test_what_we_sign_we_verify(): void
    {
        $body = '{"id":"itaja_evt_1","type":"credits.low","data":{"balance":3}}';
        $headers = Signature::sign($body, 'whsec_mine');

        $this->assertSame('itaja_evt_1', Signature::verify($body, $headers, 'whsec_mine')['id']);
    }
}
