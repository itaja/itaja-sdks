<?php

/**
 * The `Itaja` object a merchant holds: resources, product resolution, `push`.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * K1. A product named by the merchant's catalogue id is sent to the API under
 *     that id instead of Itaja's product id, or the lookup is not refreshed
 *     after a `push` that created it.
 * K2. A product that was never pushed gives a raw 404 instead of a message that
 *     says to run `itaja:push`.
 * K3. `push(dryRun: true)` writes; a real push does not send the catalogue the
 *     declaration produces; the facade and the container give different objects.
 * K4. A credit grant or consume sends a body `idempotencyKey` different from the
 *     header's: a retry would be two movements.
 * K5. `buy` sells a pack that is not on sale, or picks the wrong pack.
 * K6. `subscribe`, `check` and `report` pretend to work: they must say the API
 *     does not serve them yet, never return a fake answer.
 * K7. A customer id with a slash or a space breaks the URL.
 * K8. `with(apiKey:, baseUrl:)` is ignored, or changes the shared client the rest
 *     of the app uses (a tenant's key leaks into another request).
 * K9. The return URLs never reach the API: `buy` rebuilds its body from a fixed
 *     list of fields, so one missing from it is silently dropped and the payer
 *     stays on Itaja's return page.
 * K10. An outcome borrows another's address (two fields swapped), or an omitted
 *     one is sent as `null` (the API refuses an empty URL with 422).
 * K11. Adding the return URLs shifts `buy`'s positional parameters: an existing
 *     positional call sends its reference or language as a return URL.
 * K12. `checkout()->create()` drops or renames the return URLs it receives.
 */

namespace Itaja\Laravel\Tests;

use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Itaja\Laravel\Catalog\Feature;
use Itaja\Laravel\Catalog\License;
use Itaja\Laravel\Exceptions\ItajaException;
use Itaja\Laravel\Exceptions\NotFoundException;
use Itaja\Laravel\Facades\Itaja as ItajaFacade;
use Itaja\Laravel\Itaja;

final class ClientTest extends TestCase
{
    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $app['config']->set('itaja.base_url', 'https://api.test/api/v1');
        $app['config']->set('itaja.retries', 0);
        $app['config']->set('itaja.catalog', __DIR__.'/fixtures/itaja.php');
    }

    private function ok(mixed $data, int $status = 200): \Illuminate\Http\Client\Response|\GuzzleHttp\Promise\PromiseInterface
    {
        return Http::response(['success' => true, 'data' => $data], $status);
    }

    /** @return list<Request> */
    private function sent(): array
    {
        $sent = [];
        Http::assertSent(function (Request $r) use (&$sent): bool {
            $sent[] = $r;

            return true;
        });

        return $sent;
    }

    public function test_k3_the_facade_and_the_container_give_the_same_object(): void
    {
        $this->assertSame($this->app->make(Itaja::class), ItajaFacade::getFacadeRoot());
        $this->assertSame('sandbox', ItajaFacade::mode());
    }

    public function test_k3_a_dry_run_sends_the_dry_run_flag_and_a_push_sends_the_declared_catalogue(): void
    {
        Http::fake(['*' => $this->ok(['summary' => ['created' => 0, 'changed' => 0, 'archived' => 0, 'unchanged' => 3], 'changes' => []])]);

        ItajaFacade::push(dryRun: true);
        ItajaFacade::push();

        [$dry, $real] = $this->sent();
        $this->assertSame('PUT', $dry->method());
        $this->assertStringContainsString('dryRun=true', $dry->url());
        $this->assertStringNotContainsString('dryRun', $real->url());
        $this->assertSame(ItajaFacade::catalog(), $real->data());
    }

    public function test_k1_a_catalogue_id_is_resolved_to_the_itaja_product_id_once(): void
    {
        Http::fake([
            '*/products' => $this->ok([['id' => 'prd_77', 'catalogKey' => 'tokens'], ['id' => 'prd_88', 'catalogKey' => 'desktop']]),
            '*/products/prd_77/credits/*/balance' => $this->ok(['balance' => 42]),
        ]);

        $this->assertSame(['balance' => 42], ItajaFacade::credits()->balance('cus_1', product: 'tokens'));
        ItajaFacade::credits()->balance('cus_1', product: 'tokens');

        $lookups = array_filter($this->sent(), fn (Request $r) => str_ends_with($r->url(), '/products'));
        $this->assertCount(1, $lookups);
    }

    public function test_k1_after_a_push_the_product_ids_are_read_again_not_served_from_a_stale_map(): void
    {
        // The push re-creates "tokens" under a new Itaja id (archived, then declared again).
        $currentId = 'prd_old';
        Http::fake(function (Request $request) use (&$currentId) {
            if (str_ends_with($request->url(), '/catalog')) {
                $currentId = 'prd_new';

                return $this->ok(['summary' => ['created' => 1, 'changed' => 0, 'archived' => 1, 'unchanged' => 0], 'changes' => []]);
            }
            if (str_ends_with($request->url(), '/products')) {
                return $this->ok([['id' => $currentId, 'catalogKey' => 'tokens']]);
            }

            return $this->ok(['balance' => 5]);
        });

        ItajaFacade::credits()->balance('cus_1', product: 'tokens'); // caches tokens → prd_old
        ItajaFacade::push();
        ItajaFacade::credits()->balance('cus_1', product: 'tokens');

        $balances = array_values(array_filter($this->sent(), fn (Request $r) => str_ends_with($r->url(), '/balance')));
        $this->assertStringContainsString('/products/prd_old/', $balances[0]->url());
        $this->assertStringContainsString('/products/prd_new/', $balances[1]->url());
    }

    public function test_k1_a_dashboard_product_is_named_by_its_itaja_id_with_no_lookup(): void
    {
        Http::fake(['*' => $this->ok(['balance' => 1])]);

        ItajaFacade::credits()->balance('cus_1', productId: 'prd_dash');

        $this->assertCount(1, $this->sent());
        $this->assertStringContainsString('/products/prd_dash/credits/cus_1/balance', $this->sent()[0]->url());
    }

    public function test_k2_a_product_never_pushed_says_to_push(): void
    {
        Http::fake(['*' => $this->ok([])]);

        try {
            ItajaFacade::licenses()->issue(product: 'desktop');
            $this->fail('expected an exception');
        } catch (NotFoundException $e) {
            $this->assertSame('CATALOG_PRODUCT_NOT_PUSHED', $e->errorCode);
            $this->assertStringContainsString('itaja:push', $e->getMessage());
        }
    }

    public function test_k4_a_credit_movement_sends_the_same_idempotency_key_in_header_and_body(): void
    {
        Http::fake([
            '*/products' => $this->ok([['id' => 'prd_77', 'catalogKey' => 'tokens']]),
            '*/credits/*' => $this->ok(['balanceAfter' => 7], 201),
        ]);

        ItajaFacade::credits()->consume('cus_1', 3, product: 'tokens');
        ItajaFacade::credits()->grant('cus_1', 50, product: 'tokens', idempotencyKey: 'order-9');

        [, $consume, $grant] = $this->sent();
        $this->assertSame($consume->data()['idempotencyKey'], $consume->header('Idempotency-Key')[0]);
        $this->assertSame(3, $consume->data()['amount']);
        $this->assertSame('order-9', $grant->data()['idempotencyKey']);
        $this->assertSame(['order-9'], $grant->header('Idempotency-Key'));
    }

    public function test_k5_buy_picks_the_pack_by_its_catalogue_id_and_refuses_an_unknown_one(): void
    {
        Http::fake([
            '*/products' => $this->ok([['id' => 'prd_77', 'catalogKey' => 'tokens']]),
            '*/credit-packs' => $this->ok(['packs' => [['id' => 'pck_a', 'catalogKey' => 'small'], ['id' => 'pck_b', 'catalogKey' => 'large']]]),
            '*/credit-packs/pck_b/checkout' => $this->ok(['checkoutUrl' => 'https://pay.test/c/1'], 201),
        ]);

        $out = ItajaFacade::credits()->buy('large', 'cus_1', 'https://shop.test/thanks', product: 'tokens');

        $this->assertSame('https://pay.test/c/1', $out['checkoutUrl']);
        $this->expectException(NotFoundException::class);
        ItajaFacade::credits()->buy('huge', 'cus_1', 'https://shop.test/thanks', product: 'tokens');
    }

    private function fakePackCheckout(): void
    {
        Http::fake([
            '*/credit-packs' => $this->ok(['packs' => [['id' => 'pck_a', 'catalogKey' => 'small']]]),
            '*/credit-packs/pck_a/checkout' => $this->ok(['checkoutUrl' => 'https://pay.test/c/2'], 201),
        ]);
    }

    /** @return array<string, mixed> */
    private function lastBody(): array
    {
        $sent = $this->sent();

        return json_decode(end($sent)->body(), true);
    }

    public function test_k9_k10_buy_sends_each_return_url_under_its_own_name(): void
    {
        $this->fakePackCheckout();

        ItajaFacade::credits()->buy(
            pack: 'small',
            customerId: 'cus_1',
            homeUrl: 'https://shop.test/back',
            productId: 'prd_77',
            successUrl: 'https://shop.test/paid?order=1042#top',
            failureUrl: 'https://shop.test/failed',
            cancelUrl: 'https://shop.test/cart',
        );

        $this->assertSame([
            'customerId' => 'cus_1',
            'homeUrl' => 'https://shop.test/back',
            'successUrl' => 'https://shop.test/paid?order=1042#top',
            'failureUrl' => 'https://shop.test/failed',
            'cancelUrl' => 'https://shop.test/cart',
        ], $this->lastBody());
    }

    public function test_k10_an_omitted_return_url_is_absent_never_null(): void
    {
        $this->fakePackCheckout();

        ItajaFacade::credits()->buy(pack: 'small', customerId: 'cus_1', homeUrl: 'https://shop.test/back', productId: 'prd_77', failureUrl: 'https://shop.test/failed');

        $this->assertSame([
            'customerId' => 'cus_1',
            'homeUrl' => 'https://shop.test/back',
            'failureUrl' => 'https://shop.test/failed',
        ], $this->lastBody());
    }

    public function test_k11_an_existing_positional_call_keeps_its_meaning(): void
    {
        $this->fakePackCheckout();

        ItajaFacade::credits()->buy('small', 'cus_1', 'https://shop.test/back', null, 'prd_77', 'order-1042', 'fr');

        $this->assertSame([
            'customerId' => 'cus_1',
            'homeUrl' => 'https://shop.test/back',
            'reference' => 'order-1042',
            'language' => 'fr',
        ], $this->lastBody());
    }

    public function test_k12_checkout_create_sends_the_return_urls_as_given(): void
    {
        Http::fake(['*/checkout-sessions' => $this->ok(['id' => 'chk_1'], 201)]);

        ItajaFacade::checkout()->create([
            'homeUrl' => 'https://shop.test/back',
            'successUrl' => 'https://shop.test/paid',
            'failureUrl' => 'https://shop.test/failed',
            'cancelUrl' => 'https://shop.test/cart',
        ]);

        $this->assertStringEndsWith('/api/v1/checkout-sessions', $this->sent()[0]->url());
        $this->assertSame([
            'homeUrl' => 'https://shop.test/back',
            'successUrl' => 'https://shop.test/paid',
            'failureUrl' => 'https://shop.test/failed',
            'cancelUrl' => 'https://shop.test/cart',
        ], $this->lastBody());
    }

    public function test_k6_the_calls_the_api_does_not_serve_yet_say_so(): void
    {
        Http::fake();
        foreach ([
            fn () => ItajaFacade::subscribe('cus_1', 'pro'),
            fn () => ItajaFacade::check('cus_1', 'export'),
            fn () => ItajaFacade::report('cus_1', 'messages', 3),
        ] as $call) {
            try {
                $call();
                $this->fail('expected an exception');
            } catch (ItajaException $e) {
                $this->assertSame('NOT_YET_AVAILABLE', $e->errorCode);
            }
        }
        Http::assertNothingSent();
    }

    public function test_k8_with_gives_a_client_of_its_own_and_leaves_the_shared_one_alone(): void
    {
        Http::fake(['*' => $this->ok(['id' => 'cus_1'])]);

        $tenant = ItajaFacade::with(apiKey: 'itjp_tenant', baseUrl: 'https://staging.test/api/v1');
        $tenant->customers()->get('cus_1');
        ItajaFacade::customers()->get('cus_1');

        [$a, $b] = $this->sent();
        $this->assertSame('live', $tenant->mode());
        $this->assertSame('sandbox', ItajaFacade::mode());
        $this->assertSame('https://staging.test/api/v1/customers/cus_1', $a->url());
        $this->assertSame(['itjp_tenant'], $a->header('x-itj-key'));
        $this->assertSame('https://api.test/api/v1/customers/cus_1', $b->url());
        $this->assertSame(['itjs_test_key_for_unit_tests'], $b->header('x-itj-key'));
    }

    public function test_k7_an_id_with_a_slash_or_a_space_is_encoded(): void
    {
        Http::fake(['*' => $this->ok(['id' => 'cus_1'])]);

        ItajaFacade::customers()->get('user/42 a');

        $this->assertStringEndsWith('/customers/user%2F42%20a', $this->sent()[0]->url());
    }
}
