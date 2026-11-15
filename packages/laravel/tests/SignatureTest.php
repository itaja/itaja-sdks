<?php

/**
 * Webhook verification: Standard Webhooks (`webhook-id` / `webhook-timestamp` /
 * `webhook-signature`), the only scheme Itaja signs with.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * W1.  A signature the delivery service produced is refused (the two sides
 *      disagree on the signed content, the key, the encoding or the header
 *      format). Covered by the shared vectors of `spec/signature-vectors.json`
 *      and by the official `standard-webhooks/standard-webhooks` package, which
 *      must sign what we sign and accept what we sign.
 * W1b. A legacy `whsec_<48 hex>` secret stops working: its key must be the 36
 *      bytes the hex text decodes to AS BASE64, not the hex bytes, not the text.
 * W1c. A secret that is not base64 is refused or mis-keyed, instead of falling
 *      back to its raw bytes like the emitter does.
 * W2.  A tampered body, a body re-serialised by a JSON parser, another
 *      `webhook-id`, or a signature made with another secret is accepted.
 * W3.  A delivery older (or newer) than the tolerance is accepted: a captured
 *      request replays forever.
 * W4.  A missing header (any of the three), a non-numeric timestamp or a header
 *      with no `v1` entry throws something else than SignatureException (a 500
 *      instead of a 400), or shares one code.
 * W5.  During a secret rotation (`v1,<new> v1,<old>`, space-separated) the
 *      delivery is refused; or an entry of another version breaks the parse.
 * W6.  A signature of the wrong length or not base64 crashes instead of failing.
 * W8.  The removed `x-itaja-signature` / `x-itaja-timestamp` scheme is still
 *      accepted, alone or as a fallback.
 */

namespace Itaja\Laravel\Tests;

use Itaja\Laravel\Exceptions\SignatureException;
use Itaja\Laravel\Webhooks\Signature;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use StandardWebhooks\Exception\WebhookVerificationException;
use StandardWebhooks\Webhook;

/**
 * @phpstan-type Vector array{name: string, kind: string, secret: string, id: string, timestamp: string, body: string, signature: string}
 */
final class SignatureTest extends TestCase
{
    /** @return list<Vector> */
    private static function vectors(): array
    {
        return json_decode((string) file_get_contents(__DIR__.'/../../../spec/signature-vectors.json'), true, 512, JSON_THROW_ON_ERROR)['vectors'];
    }

    /** @return Vector */
    private static function ofKind(string $kind): array
    {
        foreach (self::vectors() as $vector) {
            if ($vector['kind'] === $kind) {
                return $vector;
            }
        }
        throw new \LogicException("No vector of kind {$kind}.");
    }

    /** @return iterable<string, array{Vector}> */
    public static function sharedVectors(): iterable
    {
        foreach (self::vectors() as $vector) {
            yield $vector['name'] => [$vector];
        }
    }

    /** @return iterable<string, array{Vector}> */
    public static function officialVectors(): iterable
    {
        foreach (self::vectors() as $vector) {
            // The official library has no raw-bytes fallback: only base64 secrets are compared.
            if ($vector['kind'] !== 'utf8-fallback-secret') {
                yield $vector['name'] => [$vector];
            }
        }
    }

    /**
     * @param  Vector  $v
     * @return array<string, string>
     */
    private static function headers(array $v, ?string $signature = null, ?string $id = null, ?string $timestamp = null): array
    {
        return ['webhook-id' => $id ?? $v['id'], 'webhook-timestamp' => $timestamp ?? $v['timestamp'], 'webhook-signature' => $signature ?? $v['signature']];
    }

    /** @param  array{id: string, timestamp: string, body: string}  $v */
    private static function mac(string $key, array $v): string
    {
        return 'v1,'.base64_encode(hash_hmac('sha256', $v['id'].'.'.$v['timestamp'].'.'.$v['body'], $key, true));
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

    /** @param  array<string, string>  $headers */
    private function check(array $headers, ?string $payload = null, ?string $secret = null, ?int $now = null, int $tolerance = Signature::DEFAULT_TOLERANCE): string
    {
        $first = self::ofKind('base64-secret');

        return $this->codeOf(fn () => Signature::verify($payload ?? $first['body'], $headers, $secret ?? $first['secret'], $tolerance, $now ?? (int) $first['timestamp']));
    }

    public function test_the_header_names_are_standard_webhooks_own(): void
    {
        $this->assertSame(['webhook-id', 'webhook-timestamp', 'webhook-signature'], [Signature::ID_HEADER, Signature::TIMESTAMP_HEADER, Signature::SIGNATURE_HEADER]);
    }

    /** @param  Vector  $v */
    #[DataProvider('sharedVectors')]
    public function test_w1_accepts_the_shared_vector(array $v): void
    {
        $event = Signature::verify($v['body'], self::headers($v), $v['secret'], now: (int) $v['timestamp']);

        $this->assertSame(json_decode($v['body'], true)['id'], $event['id']);
    }

    /** @param  Vector  $v */
    #[DataProvider('sharedVectors')]
    public function test_w1_our_signer_reproduces_the_shared_vector(array $v): void
    {
        $signed = Signature::sign($v['body'], $v['secret'], (int) $v['timestamp'], $v['id']);

        $this->assertContains($signed['webhook-signature'], explode(' ', $v['signature']));
        $this->assertSame([$v['id'], $v['timestamp']], [$signed['webhook-id'], $signed['webhook-timestamp']]);
    }

    /** @param  Vector  $v */
    #[DataProvider('officialVectors')]
    public function test_w1_the_official_library_signs_the_shared_vector_identically(array $v): void
    {
        $official = (new Webhook($v['secret']))->sign($v['id'], (int) $v['timestamp'], $v['body']);

        $this->assertContains($official, explode(' ', $v['signature']));
    }

    /** @return iterable<string, array{string}> */
    public static function base64Secrets(): iterable
    {
        yield 'base64' => [self::ofKind('base64-secret')['secret']];
        yield 'legacy-hex' => [self::ofKind('legacy-hex-secret')['secret']];
    }

    #[DataProvider('base64Secrets')]
    public function test_w1_each_side_accepts_what_the_other_signs_and_refuses_the_same_tampering(string $secret): void
    {
        $body = self::ofKind('base64-secret')['body'];
        $now = time();
        $official = new Webhook($secret);

        $mine = Signature::sign($body, $secret, $now, 'msg_cross');
        $this->assertSame('itaja_evt_txn_1', $official->verify($body, $mine)['id']);

        $theirs = ['webhook-id' => 'msg_cross', 'webhook-timestamp' => (string) $now, 'webhook-signature' => $official->sign('msg_cross', $now, $body)];
        $this->assertSame('itaja_evt_txn_1', Signature::verify($body, $theirs, $secret, now: $now)['id']);

        $tampered = str_replace('5000', '50000', $body);
        $this->assertSame('SIGNATURE_MISMATCH', $this->codeOf(fn () => Signature::verify($tampered, $mine, $secret, now: $now)));
        $this->expectException(WebhookVerificationException::class);
        $official->verify($tampered, $mine);
    }

    public function test_w1_reads_headers_in_any_casing_and_as_lists(): void
    {
        $v = self::ofKind('base64-secret');
        $headers = ['Webhook-Id' => [$v['id']], 'WEBHOOK-TIMESTAMP' => $v['timestamp'], 'Webhook-Signature' => [$v['signature']]];

        $this->assertSame('checkout.paid', Signature::verify($v['body'], $headers, $v['secret'], now: (int) $v['timestamp'])['type']);
    }

    public function test_w1b_a_legacy_hex_secret_is_keyed_by_its_base64_decoding(): void
    {
        $v = self::ofKind('legacy-hex-secret');
        $text = substr($v['secret'], strlen('whsec_'));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{48}$/', $text);
        $key = (string) base64_decode($text, true);
        $this->assertSame(36, strlen($key));
        $this->assertSame($v['signature'], self::mac($key, $v));

        // Neither the hex bytes nor the text itself is the key.
        foreach ([(string) hex2bin($text), $text, $v['secret']] as $wrong) {
            $forged = self::headers($v, signature: self::mac($wrong, $v));
            $this->assertSame('SIGNATURE_MISMATCH', $this->check($forged, $v['body'], $v['secret'], (int) $v['timestamp']));
        }
    }

    public function test_w1c_a_secret_that_is_not_canonical_base64_is_keyed_by_its_raw_bytes(): void
    {
        $fallback = self::ofKind('utf8-fallback-secret');
        $this->assertSame($fallback['signature'], self::mac(substr($fallback['secret'], strlen('whsec_')), $fallback));

        $body = '{"id":"e1","type":"t","data":{}}';
        foreach (['whsec_abcde', 'whsec_AB==', 'whsec_', 'whsec_====', 'plain text secret'] as $secret) {
            $mine = Signature::sign($body, $secret, 1760500000, 'm1');
            $key = str_starts_with($secret, 'whsec_') ? substr($secret, 6) : $secret;
            $this->assertSame(self::mac($key, ['id' => 'm1', 'timestamp' => '1760500000', 'body' => $body]), $mine['webhook-signature'], $secret);
            $this->assertSame('e1', Signature::verify($body, $mine, $secret, now: 1760500000)['id']);
        }
    }

    public function test_w2_refuses_a_tampered_body_a_reserialised_body_another_id_and_another_secret(): void
    {
        $v = self::ofKind('base64-secret');

        $this->assertSame('SIGNATURE_MISMATCH', $this->check(self::headers($v), str_replace('5000', '50000', $v['body'])));
        $this->assertSame('SIGNATURE_MISMATCH', $this->check(self::headers($v), (string) json_encode(json_decode($v['body'], true), JSON_PRETTY_PRINT)));
        $this->assertSame('SIGNATURE_MISMATCH', $this->check(self::headers($v, id: 'itaja_evt_other')));
        $this->assertSame('SIGNATURE_MISMATCH', $this->check(self::headers($v), secret: 'whsec_other'));
        $this->assertSame('SIGNATURE_MISMATCH', $this->check(self::headers($v), secret: self::ofKind('legacy-hex-secret')['secret']));
    }

    public function test_w3_refuses_outside_the_five_minute_tolerance_both_ways(): void
    {
        $v = self::ofKind('base64-secret');
        $at = (int) $v['timestamp'];

        $this->assertSame('ACCEPTED', $this->check(self::headers($v), now: $at + 300));
        $this->assertSame('ACCEPTED', $this->check(self::headers($v), now: $at - 300));
        $this->assertSame('TIMESTAMP_OUT_OF_TOLERANCE', $this->check(self::headers($v), now: $at + 301));
        $this->assertSame('TIMESTAMP_OUT_OF_TOLERANCE', $this->check(self::headers($v), now: $at - 301));
        $this->assertSame('ACCEPTED', $this->check(self::headers($v), now: $at + 301, tolerance: 600));
        // The timestamp is signed: moving it into the window does not help.
        $this->assertSame('SIGNATURE_MISMATCH', $this->check(self::headers($v, timestamp: (string) ($at + 301)), now: $at + 301));
    }

    public function test_w4_a_malformed_delivery_is_a_signature_exception_with_its_own_code(): void
    {
        $v = self::ofKind('base64-secret');
        $without = fn (string $name) => array_diff_key(self::headers($v), [$name => true]);

        $this->assertSame('SIGNATURE_MISSING', $this->check([]));
        $this->assertSame('SIGNATURE_MISSING', $this->check($without('webhook-id')));
        $this->assertSame('SIGNATURE_MISSING', $this->check($without('webhook-timestamp')));
        $this->assertSame('SIGNATURE_MISSING', $this->check($without('webhook-signature')));
        foreach (['yesterday', '1760500000.5', '-1760500000', ' 1760500000', '0x10', "1760500000\n"] as $bad) {
            $this->assertSame('TIMESTAMP_INVALID', $this->check(self::headers($v, timestamp: $bad)), $bad);
        }
        foreach ([str_replace('v1,', 'v2,', $v['signature']), 'v1', 'v1,', substr($v['signature'], 3), 'v1a,abc v2,def'] as $bad) {
            $this->assertSame('SIGNATURE_SCHEME_UNSUPPORTED', $this->check(self::headers($v, signature: $bad)), $bad);
        }
        $this->assertSame('WEBHOOK_SECRET_MISSING', $this->check(self::headers($v), secret: ''));

        $notJson = Signature::sign('not json', $v['secret'], (int) $v['timestamp']);
        $this->assertSame('PAYLOAD_INVALID', $this->check($notJson, 'not json'));
    }

    public function test_w5_during_a_secret_rotation_one_matching_entry_is_enough(): void
    {
        $this->assertCount(2, explode(' ', self::ofKind('rotation')['signature']));
        $v = self::ofKind('base64-secret');
        $current = $v['signature'];
        $stale = Signature::sign($v['body'], 'whsec_b2xkIHNlY3JldA==', (int) $v['timestamp'], $v['id'])['webhook-signature'];
        $run = fn (string $signature) => $this->check(self::headers($v, signature: $signature));

        $this->assertSame('ACCEPTED', $run("{$stale} {$current}"));
        $this->assertSame('ACCEPTED', $run("{$current} {$stale}"));
        $this->assertSame('SIGNATURE_MISMATCH', $run($stale));
        $this->assertSame('SIGNATURE_MISMATCH', $run("{$stale} {$stale}"));
        // Entries of another version are skipped, wherever they sit.
        $this->assertSame('ACCEPTED', $run("v1a,AAAA {$current} v2,BBBB"));
        $this->assertSame('SIGNATURE_MISMATCH', $run('v2,'.substr($current, 3)." {$stale}"));
    }

    public function test_w6_a_signature_that_is_not_base64_or_the_wrong_length_fails_cleanly(): void
    {
        $v = self::ofKind('base64-secret');
        foreach (['!!!not-base64!!!', 'AAAA', base64_encode(str_repeat('x', 64))] as $junk) {
            $this->assertSame('SIGNATURE_MISMATCH', $this->check(self::headers($v, signature: "v1,{$junk} v1,{$junk}")));
        }
    }

    public function test_w8_the_removed_x_itaja_scheme_is_refused_alone_or_next_to_the_new_headers(): void
    {
        $v = self::ofKind('base64-secret');
        $old = [
            'x-itaja-timestamp' => $v['timestamp'],
            'x-itaja-signature' => 'v1,'.base64_encode(hash_hmac('sha256', $v['timestamp'].'.'.$v['body'], $v['secret'], true)),
        ];

        $this->assertSame('SIGNATURE_MISSING', $this->check($old));
        $this->assertSame('SIGNATURE_MISMATCH', $this->check($old + self::headers($v, signature: 'v1,'.base64_encode(str_repeat("\0", 32)))));
    }

    public function test_what_we_sign_we_verify(): void
    {
        $body = '{"id":"itaja_evt_1","type":"credits.low","data":{"balance":3}}';
        $headers = Signature::sign($body, 'whsec_mine');

        $this->assertSame(['webhook-id', 'webhook-timestamp', 'webhook-signature'], array_keys($headers));
        $this->assertNotSame($headers['webhook-id'], Signature::sign($body, 'whsec_mine')['webhook-id']);
        $this->assertSame('itaja_evt_1', Signature::verify($body, $headers, 'whsec_mine')['id']);
    }
}
