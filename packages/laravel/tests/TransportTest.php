<?php

/**
 * The HTTP layer: envelope, typed exceptions, retries that can never charge twice.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * T1. The `{success,data}` envelope is not unwrapped, or a `success:false` body
 *     with a 200 is returned as data.
 * T2. A write is sent without an `Idempotency-Key`, or each retry uses a new one
 *     (the retry could run twice: a double charge).
 * T3. A 4xx is retried (the same refusal, N times), or a 5xx / 429 / network
 *     error / `409 IDEMPOTENCY_KEY_IN_PROGRESS` is not.
 * T4. `Retry-After` is ignored, or honoured without a ceiling.
 * T5. An error loses its stable code, status, request id or details, or maps to
 *     the wrong class.
 * T6. The API key appears in an exception message.
 * T7. The caller's own idempotency key is replaced by a generated one.
 */

namespace Itaja\Laravel\Tests;

use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request;
use Illuminate\Http\Client\ConnectionException as HttpConnectionException;
use Itaja\Laravel\Exceptions\AuthenticationException;
use Itaja\Laravel\Exceptions\ConflictException;
use Itaja\Laravel\Exceptions\ConnectionException;
use Itaja\Laravel\Exceptions\ItajaException;
use Itaja\Laravel\Exceptions\NotFoundException;
use Itaja\Laravel\Exceptions\PermissionException;
use Itaja\Laravel\Exceptions\RateLimitException;
use Itaja\Laravel\Exceptions\ServerException;
use Itaja\Laravel\Exceptions\ValidationException;
use Itaja\Laravel\Http\Transport;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class TransportTest extends TestCase
{
    private const KEY = 'itjs_super_secret_key_do_not_leak';

    /** @var list<int> */
    private array $slept = [];

    private function transport(Factory $http, int $retries = 2): Transport
    {
        return new Transport($http, self::KEY, 'https://api.test/api/v1', 5, $retries, function (int $ms): void {
            $this->slept[] = $ms;
        });
    }

    public function test_t1_the_envelope_is_unwrapped_and_a_success_false_200_is_an_error(): void
    {
        $http = new Factory;
        $http->fake([
            '*/customers/ok' => $http::response(['success' => true, 'data' => ['id' => 'cus_1']], 200),
            '*/customers/odd' => $http::response(['success' => false, 'error' => 'nope', 'code' => 'ODD'], 200),
        ]);

        $this->assertSame(['id' => 'cus_1'], $this->transport($http)->request('GET', '/customers/ok'));
        $this->expectException(ItajaException::class);
        $this->transport($http)->request('GET', '/customers/odd');
    }

    public function test_t2_every_write_carries_one_idempotency_key_reused_on_each_retry(): void
    {
        $http = new Factory;
        $http->fakeSequence()
            ->push(['success' => false, 'error' => 'down', 'code' => 'BAD_GATEWAY'], 502)
            ->push(['success' => false, 'error' => 'down', 'code' => 'BAD_GATEWAY'], 503)
            ->push(['success' => true, 'data' => ['ok' => true]], 201);

        $this->assertSame(['ok' => true], $this->transport($http)->request('POST', '/customers', null, ['name' => 'A']));

        $keys = [];
        $http->assertSentCount(3);
        $http->assertSent(function (Request $r) use (&$keys): bool {
            $keys[] = $r->header('Idempotency-Key')[0] ?? null;

            return true;
        });
        $this->assertCount(1, array_unique($keys));
        $this->assertNotNull($keys[0]);
    }

    public function test_t2_a_read_carries_no_idempotency_key(): void
    {
        $http = new Factory;
        $http->fake(['*' => $http::response(['success' => true, 'data' => []], 200)]);

        $this->transport($http)->request('GET', '/customers');

        $http->assertSent(fn (Request $r) => $r->header('Idempotency-Key') === [] && $r->header('x-itj-key') === [self::KEY]);
    }

    public function test_t7_the_callers_own_key_is_the_one_sent(): void
    {
        $http = new Factory;
        $http->fake(['*' => $http::response(['success' => true, 'data' => []], 201)]);

        $this->transport($http)->request('POST', '/customers', null, ['name' => 'A'], 'order-4217');

        $http->assertSent(fn (Request $r) => $r->header('Idempotency-Key') === ['order-4217']);
    }

    /** @return iterable<string, array{int, string, class-string<ItajaException>}> */
    public static function refusals(): iterable
    {
        yield '400' => [400, 'X', ValidationException::class];
        yield '422' => [422, 'X', ValidationException::class];
        yield '401' => [401, 'X', AuthenticationException::class];
        yield '403' => [403, 'X', PermissionException::class];
        yield '404' => [404, 'X', NotFoundException::class];
        yield '409 other' => [409, 'X', ConflictException::class];
    }

    /** @param  class-string<ItajaException>  $class */
    #[DataProvider('refusals')]
    public function test_t3_t5_a_4xx_is_never_retried_and_maps_to_its_class(int $status, string $code, string $class): void
    {
        $http = new Factory;
        $http->fake(['*' => $http::response(['success' => false, 'error' => 'refused', 'code' => 'SOME_CODE', 'details' => ['issues' => [['path' => 'a', 'message' => 'b']]]], $status, ['x-request-id' => 'req_9'])]);

        try {
            $this->transport($http)->request('POST', '/customers', null, ['name' => 'A']);
            $this->fail('expected an exception');
        } catch (ItajaException $e) {
            $this->assertInstanceOf($class, $e);
            $this->assertSame('SOME_CODE', $e->errorCode);
            $this->assertSame($status, $e->status);
            $this->assertSame('req_9', $e->requestId);
            $this->assertSame('b', $e->details['issues'][0]['message']);
        }
        $http->assertSentCount(1);
        $this->assertSame([], $this->slept);
    }

    public function test_t3_a_429_is_retried_honouring_retry_after_with_a_ceiling(): void
    {
        $http = new Factory;
        $http->fakeSequence()
            ->push(['success' => false, 'error' => 'slow', 'code' => 'RATE_LIMITED'], 429, ['Retry-After' => '2'])
            ->push(['success' => false, 'error' => 'slow', 'code' => 'RATE_LIMITED'], 429, ['Retry-After' => '3600'])
            ->push(['success' => true, 'data' => ['ok' => 1]], 200);

        $this->assertSame(['ok' => 1], $this->transport($http)->request('GET', '/customers'));
        $this->assertSame([2000, 30000], $this->slept);
    }

    public function test_t3_an_exhausted_429_becomes_a_rate_limit_exception_with_retry_after(): void
    {
        $http = new Factory;
        $http->fake(['*' => $http::response(['success' => false, 'error' => 'slow', 'code' => 'RATE_LIMITED'], 429, ['Retry-After' => '7'])]);

        try {
            $this->transport($http, retries: 1)->request('GET', '/customers');
            $this->fail('expected an exception');
        } catch (RateLimitException $e) {
            $this->assertSame(7, $e->retryAfterSeconds);
        }
        $http->assertSentCount(2);
    }

    public function test_t3_an_in_progress_idempotency_conflict_is_retried_other_conflicts_are_not(): void
    {
        $http = new Factory;
        $http->fakeSequence()
            ->push(['success' => false, 'error' => 'busy', 'code' => 'IDEMPOTENCY_KEY_IN_PROGRESS'], 409)
            ->push(['success' => true, 'data' => ['done' => true]], 201);

        $this->assertSame(['done' => true], $this->transport($http)->request('POST', '/customers', null, []));
    }

    public function test_t3_a_5xx_exhausts_its_retries_then_throws_a_server_exception(): void
    {
        $http = new Factory;
        $http->fake(['*' => $http::response(['success' => false, 'error' => 'boom', 'code' => 'INTERNAL'], 500)]);

        $this->expectException(ServerException::class);
        try {
            $this->transport($http)->request('GET', '/customers');
        } finally {
            $http->assertSentCount(3);
        }
    }

    public function test_t3_a_network_error_is_retried_then_a_connection_exception_without_the_key(): void
    {
        $http = new Factory;
        $http->fake(fn () => throw new HttpConnectionException('cURL error 6: Could not resolve host'));

        try {
            $this->transport($http)->request('GET', '/customers');
            $this->fail('expected an exception');
        } catch (ConnectionException $e) {
            $this->assertSame('CONNECTION_ERROR', $e->errorCode);
            $this->assertStringNotContainsString(self::KEY, $e->getMessage());
        }
        // two retries after the first attempt (a connection error is not a recorded request)
        $this->assertCount(2, $this->slept);
    }

    public function test_t6_no_exception_ever_carries_the_api_key(): void
    {
        $http = new Factory;
        $http->fake(['*' => $http::response(['success' => false, 'error' => 'Invalid key', 'code' => 'API_KEY_INVALID'], 401)]);

        try {
            $this->transport($http)->request('GET', '/customers');
        } catch (ItajaException $e) {
            $this->assertStringNotContainsString(self::KEY, $e->getMessage().json_encode($e->details));
        }
    }

    public function test_the_mode_follows_the_key_prefix(): void
    {
        $this->assertSame('sandbox', Transport::modeOfKey('itjs_x'));
        $this->assertSame('live', Transport::modeOfKey('itjp_x'));
    }
}
