<?php

namespace Itaja\Laravel\Catalog;

use Itaja\Laravel\Exceptions\ConfigException;

/** @internal */
final class Support
{
    public const ID_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/';

    public static function assertId(string $id, string $what): void
    {
        if (preg_match(self::ID_PATTERN, $id) !== 1) {
            throw self::error("Invalid {$what} id \"{$id}\": 1 to 64 letters, digits, \"_\" or \"-\", starting with a letter or a digit.");
        }
    }

    public static function humanize(string $id): string
    {
        $words = trim((string) preg_replace('/[_-]+/', ' ', $id));

        return mb_strtoupper(mb_substr($words, 0, 1)).mb_substr($words, 1);
    }

    /** @param  array{amount: int|float, currency: string}  $price */
    public static function assertMoney(array $price, string $what): void
    {
        if (! isset($price['amount'], $price['currency']) || ! is_numeric($price['amount']) || $price['amount'] < 0) {
            throw self::error("{$what}: price needs an `amount` (major units) and a `currency`.");
        }
        if (preg_match('/^[A-Za-z]{3}$/', (string) $price['currency']) !== 1) {
            throw self::error("{$what}: `currency` must be an ISO 4217 code such as XOF or EUR.");
        }
    }

    public static function error(string $message): ConfigException
    {
        return new ConfigException($message, 'CATALOG_DECLARATION_INVALID', 0);
    }
}
