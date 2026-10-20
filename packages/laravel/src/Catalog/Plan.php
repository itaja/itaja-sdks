<?php

namespace Itaja\Laravel\Catalog;

/**
 * A plan of a group. The group's `default` plan is its free fallback and may
 * omit `price`; every other plan needs one.
 *
 * A plan has no id of its own: its NAME is its identity within the group,
 * compared trimmed, inner whitespace collapsed and case-insensitively ("Pro",
 * " pro " and "PRO" are the same plan). Itaja assigns the system id. Renaming a
 * plan creates a new plan and archives the old one.
 */
final class Plan
{
    public const INTERVALS = ['week', 'month', 'quarter', 'year'];

    public const NAME_MAX_LENGTH = 200;

    /**
     * @param  array{amount: int|float, currency: string, interval: string, intervalCount?: int}|null  $price
     * @param  list<array{feature: string, limit?: int, reset?: string}>  $includes
     */
    private function __construct(
        public readonly string $name,
        public readonly Group $group,
        public readonly ?string $description,
        public readonly ?array $price,
        public readonly ?int $trialDays,
        public readonly bool $default,
        public readonly array $includes,
    ) {
    }

    /**
     * @param  string  $name  The plan's name: shown to customers, and its identity in the group.
     * @param  array{amount: int|float, currency: string, interval: string, intervalCount?: int}|null  $price
     * @param  list<array{feature: string, limit?: int, reset?: string}>  $includes
     */
    public static function make(
        string $name,
        Group|string $group,
        ?string $description = null,
        ?array $price = null,
        ?int $trialDays = null,
        bool $default = false,
        array $includes = [],
    ): self {
        $name = trim($name);
        if ($name === '') {
            throw Support::error('A plan needs a non-blank name: the name is the plan\'s identity in its group.');
        }
        if (mb_strlen($name) > self::NAME_MAX_LENGTH) {
            throw Support::error('Plan name "'.mb_substr($name, 0, 40).'…" is too long: at most '.self::NAME_MAX_LENGTH.' characters.');
        }
        $group = $group instanceof Group ? $group : new Group($group, Support::humanize($group));
        if (! $default && $price === null) {
            throw Support::error("Plan \"{$name}\" has no price: only the group's default plan may be free.");
        }
        if ($price !== null) {
            Support::assertMoney($price, "Plan \"{$name}\"");
            if (! in_array($price['interval'] ?? null, self::INTERVALS, true)) {
                throw Support::error("Plan \"{$name}\": price.interval must be one of ".implode(', ', self::INTERVALS).'.');
            }
        }

        return new self($name, $group, $description, $price, $trialDays, $default, $includes);
    }

    /** The name as Itaja compares it: trimmed, inner whitespace collapsed, lower-cased. */
    public function key(): string
    {
        return self::normalize($this->name);
    }

    public static function normalize(string $name): string
    {
        return mb_strtolower((string) preg_replace('/\s+/u', ' ', trim($name)));
    }
}
