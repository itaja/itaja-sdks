<?php

/**
 * The catalogue in code → the canonical document `PUT /v1/catalog` takes.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * C1. The document the SDK builds is refused by the API's own schema
 *     (`spec/catalog.schema.json`).
 * C2. It is not the document the TypeScript SDK builds for the same declaration
 *     (`spec/conformance/reference-catalog.json`): `push` from two languages would
 *     report changes that are not there. Key order inside an object is not
 *     significant (the TypeScript SDK follows the order the merchant typed); the
 *     order of every list is.
 * C3. A plan including an undeclared feature is sent anyway (422 at deploy time).
 * C4. Two default plans in a group, a paid plan without a price, a boolean
 *     feature with a limit, a metered one without, credits without a pack, or
 *     a product id used twice are accepted locally.
 * C5. An invalid id passes locally and fails on the server.
 * C6. The same declaration serialises differently twice (order, null keys).
 * C7. A plan is sent with an id, or two plans whose names differ only by case
 *     or whitespace are accepted in one group (the API treats them as one), or
 *     a blank / over-long name passes locally.
 */

namespace Itaja\Laravel\Tests;

use Itaja\Laravel\Catalog\Catalog;
use Itaja\Laravel\Catalog\CreditPack;
use Itaja\Laravel\Catalog\Credits;
use Itaja\Laravel\Catalog\Feature;
use Itaja\Laravel\Catalog\Group;
use Itaja\Laravel\Catalog\License;
use Itaja\Laravel\Catalog\Plan;
use Itaja\Laravel\Exceptions\ConfigException;
use Opis\JsonSchema\Validator;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class CatalogTest extends TestCase
{
    /** @return list<Feature|Plan|Credits|CreditPack|License> */
    private static function declare(): array
    {
        $messages = Feature::metered('messages');
        $export = Feature::boolean('export');
        $app = Group::make('app', 'My App');
        $free = Plan::make('Free', $app, default: true, includes: [$messages(limit: 100, reset: 'month')]);
        $pro = Plan::make(
            'Pro',
            $app,
            price: ['amount' => 5000, 'currency' => 'XOF', 'interval' => 'month'],
            trialDays: 7,
            includes: [$messages(limit: 2000, reset: 'month'), $export()],
        );
        $tokens = Credits::make('tokens', 'AI tokens', coinName: 'Tokens');
        $small = CreditPack::make('small', $tokens, 100, ['amount' => 1000, 'currency' => 'XOF']);
        $desktop = License::make('desktop', 'Desktop app', ['amount' => 25000, 'currency' => 'XOF'], devices: 3, duration: 'days-365');

        return [$messages, $export, $free, $pro, $small, $desktop];
    }

    private static function spec(string $file): string
    {
        return (string) file_get_contents(__DIR__.'/../../../spec/'.$file);
    }

    private static function json(mixed $value): string
    {
        return (string) json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    }

    public function test_c1_the_reference_declaration_validates_against_the_apis_schema(): void
    {
        $document = json_decode(self::json(Catalog::document(self::declare())));
        $result = (new Validator)->validate($document, self::spec('catalog.schema.json'));

        $this->assertTrue($result->isValid(), (string) json_encode($result->error()?->message()));
    }

    public function test_c2_it_is_the_document_the_typescript_sdk_builds(): void
    {
        $reference = json_decode(self::spec('conformance/reference-catalog.json'), true, 512, JSON_THROW_ON_ERROR);

        $this->assertSame(self::canonical($reference), self::canonical(Catalog::document(self::declare())));
    }

    /** Object keys sorted, list order kept. */
    private static function canonical(mixed $value): mixed
    {
        if (! is_array($value)) {
            return $value;
        }
        $value = array_map(self::canonical(...), $value);
        if (! array_is_list($value)) {
            ksort($value);
        }

        return $value;
    }

    public function test_c6_the_same_declaration_always_serialises_to_the_same_bytes(): void
    {
        $this->assertSame(self::json(Catalog::document(self::declare())), self::json(Catalog::document(self::declare())));
        $this->assertStringNotContainsString('null', self::json(Catalog::document(self::declare())));
    }

    public function test_c3_a_plan_including_an_undeclared_feature_is_refused_locally(): void
    {
        $messages = Feature::metered('messages');
        $plan = Plan::make('Free', 'app', default: true, includes: [$messages(limit: 1)]);

        $this->expectException(ConfigException::class);
        $this->expectExceptionMessage('includes feature "messages", which the catalogue does not declare');
        Catalog::document([$plan]);
    }

    /** @return iterable<string, array{callable(): mixed, string}> */
    public static function rules(): iterable
    {
        yield 'two default plans' => [fn () => Catalog::document([
            Plan::make('A', 'app', default: true),
            Plan::make('B', 'app', default: true),
        ]), 'two default plans'];
        yield 'a paid plan without a price' => [fn () => Plan::make('Pro', 'app'), 'has no price'];
        yield 'a boolean feature with a limit' => [fn () => Feature::boolean('export')(limit: 3), 'is boolean'];
        yield 'a metered feature without a limit' => [fn () => Feature::metered('messages')(), 'is metered'];
        yield 'credits without a pack' => [fn () => Catalog::document([Credits::make('tokens', 'Tokens')]), 'has no pack'];
        yield 'a product id used twice' => [fn () => Catalog::document([
            License::make('x', 'X', ['amount' => 1, 'currency' => 'XOF'], devices: 1),
            Credits::make('x', 'X'),
        ]), 'is used twice'];
        yield 'a plan declared twice (case and spaces ignored)' => [fn () => Catalog::document([
            Plan::make('Pro', 'app', default: true),
            Plan::make('  pro ', 'app', price: ['amount' => 1, 'currency' => 'XOF', 'interval' => 'month']),
        ]), 'declared twice'];
        yield 'an unknown interval' => [fn () => Plan::make('p', 'app', price: ['amount' => 1, 'currency' => 'XOF', 'interval' => 'decade']), 'interval'];
        yield 'a malformed licence duration' => [fn () => License::make('l', 'L', ['amount' => 1, 'currency' => 'XOF'], devices: 1, duration: 'forever'), 'duration'];
        yield 'a credit pack with no credits' => [fn () => CreditPack::make('p', Credits::make('t', 'T'), 0, ['amount' => 1, 'currency' => 'XOF']), 'at least 1'];
        yield 'a currency that is not ISO 4217' => [fn () => License::make('l', 'L', ['amount' => 1, 'currency' => 'CFA!'], devices: 1), 'ISO 4217'];
    }

    /** @param  callable(): mixed  $declare */
    #[DataProvider('rules')]
    public function test_c4_every_local_rule_the_api_would_enforce_later(callable $declare, string $message): void
    {
        try {
            $declare();
        } catch (ConfigException $e) {
            $this->assertStringContainsString($message, $e->getMessage());
            $this->assertSame('CATALOG_DECLARATION_INVALID', $e->errorCode);

            return;
        }
        $this->fail('expected a ConfigException');
    }

    /** @return iterable<string, array{string}> */
    public static function badIds(): iterable
    {
        yield 'empty' => [''];
        yield 'space' => ['my plan'];
        yield 'leading dash' => ['-pro'];
        yield 'too long' => [str_repeat('a', 65)];
        yield 'accent' => ['pré'];
    }

    #[DataProvider('badIds')]
    public function test_c5_ids_the_api_would_refuse_are_refused_at_declaration(string $id): void
    {
        $this->expectException(ConfigException::class);
        Feature::boolean($id);
    }

    /** @return iterable<string, array{string}> */
    public static function badPlanNames(): iterable
    {
        yield 'empty' => [''];
        yield 'blank' => ["  \t "];
        yield 'too long' => [str_repeat('a', 201)];
    }

    #[DataProvider('badPlanNames')]
    public function test_c7_a_blank_or_over_long_plan_name_is_refused(string $name): void
    {
        $this->expectException(ConfigException::class);
        Plan::make($name, 'app', default: true);
    }

    public function test_c7_a_200_character_name_is_accepted(): void
    {
        $this->assertSame(200, mb_strlen(Plan::make(str_repeat('é', 200), 'app', default: true)->name));
    }

    public function test_c7_names_differing_only_by_case_or_inner_whitespace_are_one_plan(): void
    {
        $this->expectException(ConfigException::class);
        $this->expectExceptionMessage('declared twice in group "app"');
        Catalog::document([
            Plan::make('Pro  Plus', 'app', default: true),
            Plan::make('pro plus', 'app', price: ['amount' => 1, 'currency' => 'XOF', 'interval' => 'month']),
        ]);
    }

    public function test_c7_the_same_plan_name_in_two_groups_is_allowed(): void
    {
        $document = Catalog::document([
            Plan::make('Pro', Group::make('app', 'My App'), price: ['amount' => 1, 'currency' => 'XOF', 'interval' => 'month']),
            Plan::make('Pro', Group::make('api', 'My API'), price: ['amount' => 2, 'currency' => 'XOF', 'interval' => 'month']),
        ]);

        $this->assertSame(['Pro'], array_column($document['products'][0]['plans'], 'name'));
        $this->assertSame(['Pro'], array_column($document['products'][1]['plans'], 'name'));
    }

    public function test_c7_plans_carry_a_name_and_no_id(): void
    {
        $document = Catalog::document(self::declare());
        $plans = $document['products'][0]['plans'];

        $this->assertSame(['Free', 'Pro'], array_column($plans, 'name'));
        foreach ($plans as $plan) {
            $this->assertArrayNotHasKey('id', $plan);
        }
        // Products and packs keep their id.
        $this->assertSame(['app', 'tokens', 'desktop'], array_column($document['products'], 'id'));
        $this->assertSame('small', $document['products'][1]['packs'][0]['id']);
    }

    public function test_c7_the_plan_name_is_trimmed(): void
    {
        $this->assertSame('Pro', Plan::make('  Pro ', 'app', default: true)->name);
    }
}
