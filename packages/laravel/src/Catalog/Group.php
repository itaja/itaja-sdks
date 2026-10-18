<?php

namespace Itaja\Laravel\Catalog;

/** A subscription product: its plans exclude one another for a customer. */
final class Group
{
    public function __construct(
        public readonly string $id,
        public readonly string $name,
        public readonly ?string $description = null,
    ) {
        Support::assertId($id, 'group');
    }

    public static function make(string $id, string $name, ?string $description = null): self
    {
        return new self($id, $name, $description);
    }
}
