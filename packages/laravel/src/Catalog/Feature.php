<?php

namespace Itaja\Laravel\Catalog;

/**
 * A right: `Feature::boolean('export')` (access) or `Feature::metered('messages')`
 * (a quota per period). Call it to include it in a plan:
 *
 *     $export()                              // boolean
 *     $messages(limit: 100, reset: 'month')  // metered
 */
final class Feature
{
    public const RESETS = ['day', 'week', 'month', 'year'];

    private function __construct(public readonly string $id, public readonly string $type)
    {
        Support::assertId($id, 'feature');
    }

    public static function boolean(string $id): self
    {
        return new self($id, 'boolean');
    }

    public static function metered(string $id): self
    {
        return new self($id, 'metered');
    }

    /** @return array{feature: string, limit?: int, reset?: string} */
    public function __invoke(?int $limit = null, ?string $reset = null): array
    {
        if ($this->type === 'boolean') {
            if ($limit !== null || $reset !== null) {
                throw Support::error("Feature \"{$this->id}\" is boolean: include it as \$feature(), without a limit.");
            }

            return ['feature' => $this->id];
        }
        if ($limit === null || $limit < 0) {
            throw Support::error("Feature \"{$this->id}\" is metered: include it with a whole, non-negative limit.");
        }
        if ($reset !== null && ! in_array($reset, self::RESETS, true)) {
            throw Support::error("Feature \"{$this->id}\": reset must be one of ".implode(', ', self::RESETS).'.');
        }

        return ['feature' => $this->id, 'limit' => $limit] + ($reset !== null ? ['reset' => $reset] : []);
    }
}
