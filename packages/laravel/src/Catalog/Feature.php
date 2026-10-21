<?php

namespace Itaja\Laravel\Catalog;

/**
 * A right, identified by its name: `Feature::boolean('Export')` (access) or
 * `Feature::metered('Messages')` (a quota per period). Call it to include it
 * in a plan:
 *
 *     $export()                              // boolean
 *     $messages(limit: 100, reset: 'month')  // metered
 */
final class Feature
{
    public const RESETS = ['day', 'week', 'month', 'year'];

    private function __construct(public readonly string $name, public readonly string $type)
    {
        Support::assertName($name, 'feature', "Feature::metered('Messages')");
    }

    public static function boolean(string $name): self
    {
        return new self($name, 'boolean');
    }

    public static function metered(string $name): self
    {
        return new self($name, 'metered');
    }

    /** @return array{feature: string, limit?: int, reset?: string} */
    public function __invoke(?int $limit = null, ?string $reset = null): array
    {
        if ($this->type === 'boolean') {
            if ($limit !== null || $reset !== null) {
                throw Support::error("Feature \"{$this->name}\" is boolean: include it as \$feature(), without a limit.");
            }

            return ['feature' => $this->name];
        }
        if ($limit === null || $limit < 0) {
            throw Support::error("Feature \"{$this->name}\" is metered: include it with a whole, non-negative limit.");
        }
        if ($reset !== null && ! in_array($reset, self::RESETS, true)) {
            throw Support::error("Feature \"{$this->name}\": reset must be one of ".implode(', ', self::RESETS).'.');
        }

        return ['feature' => $this->name, 'limit' => $limit] + ($reset !== null ? ['reset' => $reset] : []);
    }
}
