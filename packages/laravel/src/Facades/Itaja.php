<?php

namespace Itaja\Laravel\Facades;

use Illuminate\Support\Facades\Facade;

/**
 * @method static string mode()
 * @method static array catalog()
 * @method static array push(bool $dryRun = false, ?string $idempotencyKey = null)
 * @method static \Itaja\Laravel\Resources\Customers customers()
 * @method static \Itaja\Laravel\Resources\Checkout checkout()
 * @method static \Itaja\Laravel\Resources\Credits credits()
 * @method static \Itaja\Laravel\Resources\Licenses licenses()
 * @method static \Itaja\Laravel\Resources\Subscriptions subscriptions()
 * @method static mixed request(string $method, string $path, ?array $query = null, mixed $body = null, ?string $idempotencyKey = null)
 *
 * @see \Itaja\Laravel\Itaja
 */
class Itaja extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return \Itaja\Laravel\Itaja::class;
    }
}
