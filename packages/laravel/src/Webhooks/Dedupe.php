<?php

namespace Itaja\Laravel\Webhooks;

use Illuminate\Contracts\Cache\Repository;

/**
 * Remembers which event ids were processed, so a redelivery is not handled
 * twice. It uses a Laravel cache store: behind several instances, point
 * `itaja.webhook.dedupe_store` at a shared one (Redis, database).
 */
final class Dedupe
{
    public function __construct(private readonly Repository $cache, private readonly int $ttlSeconds = 86_400)
    {
    }

    public function has(string $eventId): bool
    {
        return $this->cache->has($this->key($eventId));
    }

    /** Called once every listener of the event has succeeded. */
    public function add(string $eventId): void
    {
        $this->cache->put($this->key($eventId), 1, $this->ttlSeconds);
    }

    private function key(string $eventId): string
    {
        return 'itaja:event:'.$eventId;
    }
}
