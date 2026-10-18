<?php

namespace Itaja\Laravel\Catalog;

/**
 * A plan of a group. The group's `default` plan is its free fallback and may
 * omit `price`; every other plan needs one.
 */
final class Plan
{
    public const INTERVALS = ['week', 'month', 'quarter', 'year'];

    /**
     * @param  array{amount: int|float, currency: string, interval: string, intervalCount?: int}|null  $price
     * @param  list<array{feature: string, limit?: int, reset?: string}>  $includes
     */
    private function __construct(
        public readonly string $id,
        public readonly Group $group,
        public readonly string $name,
        public readonly ?string $description,
        public readonly ?array $price,
        public readonly ?int $trialDays,
        public readonly bool $default,
        public readonly array $includes,
    ) {
    }

    /**
     * @param  array{amount: int|float, currency: string, interval: string, intervalCount?: int}|null  $price
     * @param  list<array{feature: string, limit?: int, reset?: string}>  $includes
     */
    public static function make(
        string $id,
        Group|string $group,
        ?string $name = null,
        ?string $description = null,
        ?array $price = null,
        ?int $trialDays = null,
        bool $default = false,
        array $includes = [],
    ): self {
        Support::assertId($id, 'plan');
        $group = $group instanceof Group ? $group : new Group($group, Support::humanize($group));
        if (! $default && $price === null) {
            throw Support::error("Plan \"{$id}\" has no price: only the group's default plan may be free.");
        }
        if ($price !== null) {
            Support::assertMoney($price, "Plan \"{$id}\"");
            if (! in_array($price['interval'] ?? null, self::INTERVALS, true)) {
                throw Support::error("Plan \"{$id}\": price.interval must be one of ".implode(', ', self::INTERVALS).'.');
            }
        }

        return new self($id, $group, $name ?? Support::humanize($id), $description, $price, $trialDays, $default, $includes);
    }
}
