<?php

namespace Itaja\Laravel\Catalog;

/**
 * A subscription product, identified by its name: its plans exclude one
 * another for a customer.
 */
final class Group
{
    public function __construct(
        public readonly string $name,
        public readonly ?string $description = null,
    ) {
        Support::assertName($name, 'product', "Group::make('My App')");
    }

    public static function make(string $name, ?string $description = null): self
    {
        return new self($name, $description);
    }
}
