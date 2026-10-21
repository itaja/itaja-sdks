<?php

namespace Itaja\Laravel\Catalog;

use Itaja\Laravel\Exceptions\ConfigException;

/** @internal */
final class Support
{
    /** The longest name the API accepts, for every catalogue item. */
    public const NAME_MAX_LENGTH = 200;

    /**
     * A catalogue item's identity: Unicode NFC, trimmed, inner whitespace
     * collapsed to one space, lower-cased, exactly as the API compares names
     * (and stores them as `catalogKey`).
     */
    public static function normalize(string $name): string
    {
        $nfc = \Normalizer::normalize($name, \Normalizer::FORM_C);

        return mb_strtolower(trim((string) preg_replace('/\s+/u', ' ', is_string($nfc) ? $nfc : $name)));
    }

    public static function assertName(string $name, string $what, string $example): void
    {
        if (preg_match('/\S/u', $name) !== 1) {
            throw self::error("A {$what} needs a name: it is its identity (there is no id), e.g. {$example}.");
        }
        $length = mb_strlen($name);
        if ($length > self::NAME_MAX_LENGTH) {
            throw self::error("The {$what} name \"".mb_substr($name, 0, 40)."…\" is {$length} characters long: at most ".self::NAME_MAX_LENGTH.'.');
        }
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
