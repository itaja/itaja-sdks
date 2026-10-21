<?php

namespace Itaja\Laravel\Catalog;

/**
 * A bundle of credits sold at a fixed price. Its name is its identity inside
 * its credits product, and the label the buyer reads (`'100 tokens'`).
 */
final class CreditPack
{
    /** @param  array{amount: int|float, currency: string}  $price */
    private function __construct(
        public readonly string $name,
        public readonly Credits $of,
        public readonly int $credits,
        public readonly array $price,
        public readonly ?string $description,
    ) {
    }

    /** @param  array{amount: int|float, currency: string}  $price */
    public static function make(
        string $name,
        Credits $of,
        int $credits,
        array $price,
        ?string $description = null,
    ): self {
        Support::assertName($name, 'credit pack', "CreditPack::make('100 tokens', \$tokens, 100, \$price)");
        if ($credits < 1) {
            throw Support::error("Credit pack \"{$name}\": credits must be a whole number of at least 1.");
        }
        Support::assertMoney($price, "Credit pack \"{$name}\"");

        return new self($name, $of, $credits, $price, $description);
    }
}
