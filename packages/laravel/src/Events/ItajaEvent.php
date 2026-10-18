<?php

namespace Itaja\Laravel\Events;

/**
 * Every verified delivery is dispatched as this event. Listen to it, or to the
 * one of the type you care about (`Itaja\Laravel\Events\CheckoutPaid`, …).
 */
class ItajaEvent
{
    /**
     * @param  array<string, mixed>  $data  the topic's documented payload
     */
    public function __construct(
        /** `itaja_evt_…` — the identity a retried delivery keeps. */
        public readonly string $id,
        /** `checkout.paid`, `credits.low`, … */
        public readonly string $type,
        public readonly array $data,
        public readonly ?string $mode = null,
        public readonly ?string $apiVersion = null,
        public readonly ?string $createdAt = null,
    ) {
    }

    /**
     * @param  array<string, mixed>  $envelope
     */
    public static function fromEnvelope(array $envelope): static
    {
        return new static(
            $envelope['id'],
            $envelope['type'],
            $envelope['data'],
            $envelope['mode'] ?? null,
            $envelope['apiVersion'] ?? null,
            $envelope['createdAt'] ?? null,
        );
    }
}
