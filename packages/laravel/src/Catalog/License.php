<?php

namespace Itaja\Laravel\Catalog;

/** A licence key that unlocks your software on a number of devices. */
final class License
{
    /** @param  array{amount: int|float, currency: string}  $price */
    private function __construct(
        public readonly string $id,
        public readonly string $name,
        public readonly ?string $description,
        public readonly array $price,
        public readonly ?int $devices,
        public readonly ?string $duration,
    ) {
    }

    /**
     * @param  array{amount: int|float, currency: string}  $price
     * @param  int|null  $devices  devices one key unlocks; null = unlimited
     * @param  string|null  $duration  "lifetime", "days-N" or "from-first-activation-days-N"
     */
    public static function make(
        string $id,
        string $name,
        array $price,
        ?int $devices,
        ?string $duration = null,
        ?string $description = null,
    ): self {
        Support::assertId($id, 'license');
        Support::assertMoney($price, "License \"{$id}\"");
        if ($duration !== null && preg_match('/^(lifetime|days-\d+|from-first-activation-days-\d+)$/', $duration) !== 1) {
            throw Support::error("License \"{$id}\": duration must be \"lifetime\", \"days-N\" or \"from-first-activation-days-N\".");
        }

        return new self($id, $name, $description, $price, $devices, $duration);
    }
}
