<?php

/**
 * The mounted route (`POST itaja/webhook`) and the Laravel events it dispatches.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * R1. The route is not mounted, or Laravel's CSRF protection rejects Itaja's POST.
 * R2. A bad signature reaches a listener, or answers something else than 400.
 * R3. The same event id delivered twice runs the listeners twice.
 * R4. A listener that throws is acknowledged (200) or marked processed: Itaja
 *     never redelivers and the event is lost. After the failure, the redelivery
 *     must run the listener again.
 * R5. A sandbox event reaches a live key's listeners (or the reverse).
 * R6. An event type this version does not know throws instead of reaching the
 *     catch-all `ItajaEvent`.
 * R7. A known type is not dispatched as its own class, with its data intact.
 * R8. The body is re-read after Laravel decoded it, so the raw bytes differ and
 *     a valid signature fails (pretty-printed JSON, unicode, escaped slashes).
 */

namespace Itaja\Laravel\Tests;

use Illuminate\Support\Facades\Event;
use Itaja\Laravel\Events\CheckoutPaid;
use Itaja\Laravel\Events\CreditsLow;
use Itaja\Laravel\Events\ItajaEvent;
use Itaja\Laravel\Webhooks\Signature;
use RuntimeException;

final class WebhookRouteTest extends TestCase
{
    private function deliver(string $type, array $data = [], string $id = 'itaja_evt_1', ?string $mode = 'sandbox', ?string $secret = null, ?string $rawBody = null)
    {
        $body = $rawBody ?? (string) json_encode(array_filter([
            'id' => $id, 'type' => $type, 'apiVersion' => 'v1', 'mode' => $mode, 'createdAt' => '2026-10-15T10:00:00.000Z', 'data' => $data,
        ], fn ($v) => $v !== null), JSON_UNESCAPED_SLASHES);
        $headers = Signature::sign($body, $secret ?? 'whsec_test');

        return $this->call('POST', '/itaja/webhook', [], [], [], $this->transform($headers) + ['CONTENT_TYPE' => 'application/json'], $body);
    }

    /** @param  array<string, string>  $headers */
    private function transform(array $headers): array
    {
        $server = [];
        foreach ($headers as $name => $value) {
            $server['HTTP_'.strtoupper(str_replace('-', '_', $name))] = $value;
        }

        return $server;
    }

    public function test_r1_r7_a_signed_delivery_is_accepted_and_dispatched_as_its_own_class(): void
    {
        Event::fake([CheckoutPaid::class, ItajaEvent::class]);

        $this->deliver('checkout.paid', ['checkoutId' => 'chk_1', 'amount' => 5000])
            ->assertOk()->assertJson(['received' => true, 'outcome' => 'handled']);

        Event::assertDispatched(CheckoutPaid::class, fn (CheckoutPaid $e) => $e->data['checkoutId'] === 'chk_1' && $e->id === 'itaja_evt_1' && $e->mode === 'sandbox');
        Event::assertDispatched(ItajaEvent::class);
    }

    public function test_r2_a_bad_signature_answers_400_and_reaches_no_listener(): void
    {
        Event::fake([CheckoutPaid::class, ItajaEvent::class]);

        $this->deliver('checkout.paid', [], secret: 'whsec_wrong')->assertStatus(400)->assertJson(['outcome' => 'invalid_signature']);

        Event::assertNotDispatched(CheckoutPaid::class);
        Event::assertNotDispatched(ItajaEvent::class);
    }

    public function test_r3_the_same_event_id_runs_the_listeners_once(): void
    {
        $calls = 0;
        Event::listen(CheckoutPaid::class, function () use (&$calls): void {
            $calls++;
        });

        $this->deliver('checkout.paid', ['checkoutId' => 'c'])->assertJson(['outcome' => 'handled']);
        $this->deliver('checkout.paid', ['checkoutId' => 'c'])->assertJson(['outcome' => 'duplicate']);

        $this->assertSame(1, $calls);
    }

    public function test_r4_a_throwing_listener_answers_500_and_the_redelivery_runs_it_again(): void
    {
        $attempts = 0;
        Event::listen(CheckoutPaid::class, function () use (&$attempts): void {
            $attempts++;
            if ($attempts === 1) {
                throw new RuntimeException('fulfilment failed');
            }
        });

        $this->withoutExceptionHandling([RuntimeException::class]);
        $this->deliver('checkout.paid', ['checkoutId' => 'c'])->assertStatus(500)->assertJson(['outcome' => 'handler_failed']);
        $this->deliver('checkout.paid', ['checkoutId' => 'c'])->assertOk()->assertJson(['outcome' => 'handled']);

        $this->assertSame(2, $attempts);
    }

    public function test_r5_an_event_of_the_other_mode_is_acknowledged_and_ignored(): void
    {
        Event::fake([CheckoutPaid::class, CreditsLow::class, ItajaEvent::class]);

        // the test key is itjs_ (sandbox): a live event must not reach it
        $this->deliver('checkout.paid', [], mode: 'live')->assertOk()->assertJson(['outcome' => 'ignored_mode']);
        Event::assertNotDispatched(CheckoutPaid::class);
        Event::assertNotDispatched(ItajaEvent::class);

        $this->deliver('credits.low', ['balance' => 1], id: 'itaja_evt_2', mode: null)->assertOk()->assertJson(['outcome' => 'handled']);
        Event::assertDispatched(CreditsLow::class);
    }

    public function test_r6_an_unknown_type_reaches_the_catch_all_without_throwing(): void
    {
        Event::fake([ItajaEvent::class]);

        $this->deliver('subscription.activated', ['planId' => 'pro'])->assertOk()->assertJson(['outcome' => 'handled']);

        Event::assertDispatched(ItajaEvent::class, fn (ItajaEvent $e) => $e->type === 'subscription.activated' && $e->data['planId'] === 'pro');
    }

    public function test_r8_the_signature_is_checked_on_the_exact_raw_bytes(): void
    {
        Event::fake([CheckoutPaid::class, ItajaEvent::class]);
        $pretty = "{\n  \"id\": \"itaja_evt_raw\",\n  \"type\": \"checkout.paid\",\n  \"mode\": \"sandbox\",\n  \"data\": {\"name\": \"Ça coûte 5000 F\\u00e7\", \"url\": \"https://x.y/a\\/b\"}\n}";

        $this->deliver('', rawBody: $pretty)->assertOk()->assertJson(['outcome' => 'handled']);
    }

    public function test_only_post_is_routed(): void
    {
        $this->get('/itaja/webhook')->assertStatus(405);
    }
}
