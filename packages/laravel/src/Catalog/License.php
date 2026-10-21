<?php

namespace Itaja\Laravel\Catalog;

/** A licence key that unlocks your software on a number of devices, identified by its name. */
final class License
{
    /** @param  array{amount: int|float, currency: string}  $price */
    private function __construct(
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
        string $name,
        array $price,
        ?int $devices,
        ?string $duration = null,
        ?string $description = null,
    ): self {
        Support::assertName($name, 'product', "License::make('Desktop app', price: \$price, devices: 3)");
        Support::assertMoney($price, "License \"{$name}\"");
        if ($duration !== null && preg_match('/^(lifetime|days-\d+|from-first-activation-days-\d+)$/', $duration) !== 1) {
            throw Support::error("License \"{$name}\": duration must be \"lifetime\", \"days-N\" or \"from-first-activation-days-N\".");
        }

        return new self($name, $description, $price, $devices, $duration);
    }
}
