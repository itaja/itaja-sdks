<?php

namespace Itaja\Laravel\Catalog;

/** A credit currency your app spends as the buyer uses it. Sell it with `CreditPack`. */
final class Credits
{
    public function __construct(
        public readonly string $id,
        public readonly string $name,
        public readonly ?string $description = null,
        /** What the buyer calls one credit (`Tokens`, `Coins`). */
        public readonly ?string $coinName = null,
    ) {
        Support::assertId($id, 'credits');
    }

    public static function make(string $id, string $name, ?string $description = null, ?string $coinName = null): self
    {
        return new self($id, $name, $description, $coinName);
    }
}
