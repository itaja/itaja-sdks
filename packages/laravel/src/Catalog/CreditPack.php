<?php

namespace Itaja\Laravel\Catalog;

/** A bundle of credits sold at a fixed price. */
final class CreditPack
{
    /** @param  array{amount: int|float, currency: string}  $price */
    private function __construct(
        public readonly string $id,
        public readonly Credits $of,
        public readonly int $credits,
        public readonly array $price,
        public readonly string $label,
        public readonly ?string $description,
    ) {
    }

    /** @param  array{amount: int|float, currency: string}  $price */
    public static function make(
        string $id,
        Credits $of,
        int $credits,
        array $price,
        ?string $label = null,
        ?string $description = null,
    ): self {
        Support::assertId($id, 'credit pack');
        if ($credits < 1) {
            throw Support::error("Credit pack \"{$id}\": credits must be a whole number of at least 1.");
        }
        Support::assertMoney($price, "Credit pack \"{$id}\"");

        return new self($id, $of, $credits, $price, $label ?? "{$credits} ".($of->coinName ?? $of->name), $description);
    }
}
