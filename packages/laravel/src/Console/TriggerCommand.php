<?php

namespace Itaja\Laravel\Console;

use Illuminate\Console\Command;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Str;
use Itaja\Laravel\Events\EventMap;
use Itaja\Laravel\Webhooks\Signature;

class TriggerCommand extends Command
{
    protected $signature = 'itaja:trigger {type : An event type, e.g. checkout.paid} {--url= : Where to send it (default: this app\'s webhook route)} {--data= : The event data as JSON} {--mode=sandbox : sandbox or live}';

    protected $description = 'Send a signed sample event to your webhook route, to test your listeners locally';

    public function handle(Factory $http): int
    {
        $type = (string) $this->argument('type');
        $secret = (string) config('itaja.webhook_secret');
        if ($secret === '') {
            $this->error('Set ITAJA_WEBHOOK_SECRET to the secret your route checks.');

            return self::FAILURE;
        }
        if (! array_key_exists($type, EventMap::TOPICS)) {
            $this->error("Unknown event type \"{$type}\". Known: ".implode(', ', array_keys(EventMap::TOPICS)).'.');

            return self::FAILURE;
        }

        $data = $this->option('data') !== null ? json_decode((string) $this->option('data'), true) : self::sample($type);
        if (! is_array($data)) {
            $this->error('No sample for this type, or --data is not a JSON object: pass --data \'{...}\'.');

            return self::FAILURE;
        }
        $url = $this->option('url') ?: url((string) config('itaja.webhook.path', 'itaja/webhook'));
        $payload = (string) json_encode([
            'id' => 'itaja_evt_trigger_'.Str::uuid(),
            'type' => $type,
            'apiVersion' => 'v1',
            'mode' => $this->option('mode') === 'live' ? 'live' : 'sandbox',
            'createdAt' => gmdate('Y-m-d\TH:i:s.000\Z'),
            'data' => $data,
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        $response = $http->withHeaders(Signature::sign($payload, $secret))->withBody($payload, 'application/json')->post($url);
        $this->line("{$type} → {$url}: HTTP {$response->status()} {$response->body()}");

        return $response->successful() ? self::SUCCESS : self::FAILURE;
    }

    /** @return array<string, mixed>|null */
    private static function sample(string $type): ?array
    {
        $now = gmdate('Y-m-d\TH:i:s.000\Z');
        $invoice = ['productId' => 'prd_sample', 'contractId' => 'sub_sample', 'customerId' => 'cus_sample', 'planId' => 'pln_sample', 'invoiceId' => 'inv_sample', 'invoiceNumber' => 1, 'amount' => 5000, 'currency' => 'XOF', 'periodStart' => $now, 'periodEnd' => $now, 'dueDate' => $now];

        return [
            'checkout.paid' => ['checkoutId' => 'chk_sample', 'productId' => null, 'transactionId' => 'txn_sample', 'amount' => 5000, 'currency' => 'XOF', 'paidAt' => $now],
            'credits.granted' => ['productId' => 'prd_sample', 'walletId' => 'cwl_sample', 'customerId' => 'cus_sample', 'amount' => 100, 'delta' => 100, 'balanceAfter' => 100, 'reason' => null, 'idempotencyKey' => 'sample-grant'],
            'credits.low' => ['productId' => 'prd_sample', 'walletId' => 'cwl_sample', 'customerId' => 'cus_sample', 'balance' => 10, 'threshold' => 20, 'idempotencyKey' => 'sample-consume'],
            'license.issued' => ['productId' => 'prd_sample', 'keyId' => 'key_sample', 'key' => 'ITJ-••••-••••-SMPL', 'customerId' => 'cus_sample', 'checkoutId' => null, 'activationsMax' => 3, 'expiresAt' => null, 'status' => 'ACTIVE'],
            'invoice.paid' => $invoice + ['paidAt' => $now],
            'subscription.canceled' => ['productId' => 'prd_sample', 'contractId' => 'sub_sample', 'customerId' => 'cus_sample', 'planId' => 'pln_sample', 'status' => 'CANCELED', 'reason' => 'merchant', 'collectionMode' => 'MANUAL', 'currentPeriodStart' => $now, 'currentPeriodEnd' => $now, 'canceledAt' => $now, 'endedAt' => null],
        ][$type] ?? null;
    }
}
