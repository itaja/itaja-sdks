<?php

namespace Itaja\Laravel\Webhooks;

use Illuminate\Contracts\Events\Dispatcher;
use Itaja\Laravel\Events\EventMap;
use Itaja\Laravel\Events\ItajaEvent;
use Itaja\Laravel\Exceptions\SignatureException;
use Throwable;

/**
 * The framework-free core of the webhook route: a raw body and headers in, a
 * status out. It verifies the signature on the raw body, ignores an event of
 * the other mode, drops a delivery it already processed, dispatches the
 * Laravel events, and answers 500 when a listener throws so Itaja delivers again.
 */
final class Processor
{
    public const HANDLED = 'handled';

    public const DUPLICATE = 'duplicate';

    public const IGNORED_MODE = 'ignored_mode';

    public const INVALID_SIGNATURE = 'invalid_signature';

    public const HANDLER_FAILED = 'handler_failed';

    public function __construct(
        private readonly Dispatcher $events,
        private readonly Dedupe $dedupe,
        private readonly string $secret,
        private readonly string $mode,
        private readonly int $tolerance = Signature::DEFAULT_TOLERANCE,
        /** @var (callable(Throwable, ItajaEvent): void)|null */
        private $onError = null,
    ) {
    }

    /**
     * @param  array<string, string|list<string>|null>  $headers
     * @return array{status: int, outcome: string, eventId: string|null}
     */
    public function process(string $payload, array $headers): array
    {
        try {
            $envelope = Signature::verify($payload, $headers, $this->secret, $this->tolerance);
        } catch (SignatureException) {
            return ['status' => 400, 'outcome' => self::INVALID_SIGNATURE, 'eventId' => null];
        }

        $id = $envelope['id'];
        if (isset($envelope['mode']) && $envelope['mode'] !== $this->mode) {
            return ['status' => 200, 'outcome' => self::IGNORED_MODE, 'eventId' => $id];
        }
        if ($this->dedupe->has($id)) {
            return ['status' => 200, 'outcome' => self::DUPLICATE, 'eventId' => $id];
        }

        $class = EventMap::classFor($envelope['type']);
        $event = $class::fromEnvelope($envelope);

        try {
            if ($class !== ItajaEvent::class) {
                $this->events->dispatch($event);
            }
            // The catch-all: every delivery, including types this version does not know yet.
            $this->events->dispatch($class === ItajaEvent::class ? $event : ItajaEvent::fromEnvelope($envelope));
        } catch (Throwable $e) {
            // Not marked processed: Itaja's redelivery runs the listeners again.
            if ($this->onError !== null) {
                ($this->onError)($e, $event);
            }

            return ['status' => 500, 'outcome' => self::HANDLER_FAILED, 'eventId' => $id];
        }

        $this->dedupe->add($id);

        return ['status' => 200, 'outcome' => self::HANDLED, 'eventId' => $id];
    }
}
