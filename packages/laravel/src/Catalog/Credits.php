<?php

namespace Itaja\Laravel\Catalog;

/**
 * A credit currency your app spends as the buyer uses it, identified by its
 * name. Sell it with `CreditPack`.
 */
final class Credits
{
    public function __construct(
        public readonly string $name,
        public readonly ?string $description = null,
        /** What the buyer calls one credit (`Tokens`, `Coins`). Defaults to the name. */
        public readonly ?string $coinName = null,
    ) {
        Support::assertName($name, 'product', "Credits::make('AI tokens')");
    }

    public static function make(string $name, ?string $description = null, ?string $coinName = null): self
    {
        return new self($name, $description, $coinName);
    }
}
