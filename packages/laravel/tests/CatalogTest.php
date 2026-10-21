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
 *     feature with a limit, a metered one without, or credits without a pack
 *     are accepted locally.
 * C5. A blank or over-long name passes locally and fails on the server.
 * C6. The same declaration serialises differently twice (order, null keys).
 * C7. An id (or a pack label) is accepted or emitted anywhere: features,
 *     products, packs and plans are identified by their name only.
 * C8. Two items of one scope whose names differ only by case or whitespace
 *     are accepted locally, though the API sees one — or the same plan or
 *     pack name under two products is refused, though each is its own scope.
 */

namespace Itaja\Laravel\Tests;

use Itaja\Laravel\Catalog\Catalog;
use Itaja\Laravel\Catalog\CreditPack;
use Itaja\Laravel\Catalog\Credits;
use Itaja\Laravel\Catalog\Feature;
use Itaja\Laravel\Catalog\Group;
use Itaja\Laravel\Catalog\License;
use Itaja\Laravel\Catalog\Plan;
use Itaja\Laravel\Catalog\Support;
use Itaja\Laravel\Exceptions\ConfigException;
use Opis\JsonSchema\Validator;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class CatalogTest extends TestCase
{
    /** @return list<Feature|Plan|Credits|CreditPack|License> */
    private static function declare(): array
    {
        $messages = Feature::metered('Messages');
        $export = Feature::boolean('Export');
        $app = Group::make('My App');
        $free = Plan::make('Free', $app, default: true, includes: [$messages(limit: 100, reset: 'month')]);
        $pro = Plan::make(
            'Pro',
            $app,
            price: ['amount' => 5000, 'currency' => 'XOF', 'interval' => 'month'],
            trialDays: 7,
            includes: [$messages(limit: 2000, reset: 'month'), $export()],
        );
        $tokens = Credits::make('AI tokens', coinName: 'Tokens');
        $small = CreditPack::make('100 tokens', $tokens, 100, ['amount' => 1000, 'currency' => 'XOF']);
        $desktop = License::make('Desktop app', ['amount' => 25000, 'currency' => 'XOF'], devices: 3, duration: 'days-365');

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

    public function test_c2_it_is_byte_for_byte_the_cross_language_reference(): void
    {
        $reference = json_decode(self::spec('conformance/reference-catalog.json'), true, 512, JSON_THROW_ON_ERROR);

        // Same keys in the same order: every SDK emits the same bytes.
        $this->assertSame($reference, Catalog::document(self::declare()));
        $this->assertSame(
            json_encode($reference, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            json_encode(Catalog::document(self::declare()), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        );
    }

    public function test_c6_the_same_declaration_always_serialises_to_the_same_bytes(): void
    {
        $this->assertSame(self::json(Catalog::document(self::declare())), self::json(Catalog::document(self::declare())));
        $this->assertStringNotContainsString('null', self::json(Catalog::document(self::declare())));
    }

    public function test_c3_a_plan_including_an_undeclared_feature_is_refused_locally(): void
    {
        $seats = Feature::metered('Seats');
        $plan = Plan::make('Free', 'My App', default: true, includes: [$seats(limit: 1)]);

        $this->expectException(ConfigException::class);
        $this->expectExceptionMessage('includes feature "Seats", which the catalogue does not declare');
        Catalog::document([$plan]);
    }

    public function test_c3_includes_match_the_declared_feature_by_normalised_name(): void
    {
        $declared = Feature::metered('Messages');
        $spelledOtherwise = Feature::metered(' messages ');
        $document = Catalog::document([$declared, Plan::make('Free', 'My App', default: true, includes: [$spelledOtherwise(limit: 1)])]);

        $this->assertSame([['name' => 'Messages', 'type' => 'metered']], $document['features']);
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
        yield 'credits without a pack' => [fn () => Catalog::document([Credits::make('Tokens')]), 'has no pack'];
        yield 'an unknown interval' => [fn () => Plan::make('p', 'app', price: ['amount' => 1, 'currency' => 'XOF', 'interval' => 'decade']), 'interval'];
        yield 'a malformed licence duration' => [fn () => License::make('L', ['amount' => 1, 'currency' => 'XOF'], devices: 1, duration: 'forever'), 'duration'];
        yield 'a credit pack with no credits' => [fn () => CreditPack::make('p', Credits::make('T'), 0, ['amount' => 1, 'currency' => 'XOF']), 'at least 1'];
        yield 'a currency that is not ISO 4217' => [fn () => License::make('L', ['amount' => 1, 'currency' => 'CFA!'], devices: 1), 'ISO 4217'];
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

    /** @return iterable<string, array{string, callable(string): mixed}> */
    public static function builders(): iterable
    {
        yield 'feature' => ['feature', fn (string $name) => Feature::boolean($name)];
        yield 'group' => ['product', fn (string $name) => Group::make($name)];
        yield 'plan' => ['plan', fn (string $name) => Plan::make($name, 'My App', default: true)];
        yield 'credits' => ['product', fn (string $name) => Credits::make($name)];
        yield 'credit pack' => ['credit pack', fn (string $name) => CreditPack::make($name, Credits::make('C'), 1, ['amount' => 1, 'currency' => 'XOF'])];
        yield 'licence' => ['product', fn (string $name) => License::make($name, ['amount' => 1, 'currency' => 'XOF'], devices: 1)];
    }

    /** @param  callable(string): mixed  $build */
    #[DataProvider('builders')]
    public function test_c5_every_name_is_required_non_blank_and_at_most_200_characters(string $what, callable $build): void
    {
        foreach (['', '   ', "\t\n"] as $blank) {
            try {
                $build($blank);
                $this->fail("a blank {$what} name was accepted");
            } catch (ConfigException $e) {
                $this->assertStringContainsString("A {$what} needs a name", $e->getMessage());
            }
        }
        try {
            $build(str_repeat('x', 201));
            $this->fail("a 201-character {$what} name was accepted");
        } catch (ConfigException $e) {
            $this->assertStringContainsString('at most 200', $e->getMessage());
        }
        $build(str_repeat('é', 200));
        $this->addToAssertionCount(1);
    }

    public function test_c7_the_emitted_document_carries_no_id_nor_label_anywhere(): void
    {
        $keys = [];
        $walk = function (mixed $value) use (&$walk, &$keys): void {
            if (! is_array($value)) {
                return;
            }
            foreach ($value as $key => $child) {
                if (is_string($key)) {
                    $keys[] = $key;
                }
                $walk($child);
            }
        };
        $walk(Catalog::document(self::declare()));

        $this->assertNotContains('id', $keys);
        $this->assertNotContains('label', $keys);
    }

    public function test_c7_no_builder_takes_an_id(): void
    {
        $this->expectException(\Error::class);
        $this->expectExceptionMessage('Unknown named parameter $label');
        CreditPack::make('100 tokens', Credits::make('AI tokens'), 100, ['amount' => 1, 'currency' => 'XOF'], label: '100');
    }

    /** @return iterable<string, array{list<Feature|Plan|Credits|CreditPack|License>}> */
    public static function productTwins(): iterable
    {
        $xof = ['amount' => 1, 'currency' => 'XOF'];
        yield 'a group and a licence' => [[Plan::make('Free', 'My App', default: true), License::make(' my  app ', $xof, devices: 1)]];
        yield 'credits and a group' => [[CreditPack::make('P', Credits::make('AI tokens'), 1, $xof), Plan::make('Free', 'AI TOKENS', default: true)]];
        yield 'two licences' => [[License::make('Desktop app', $xof, devices: 1), License::make('desktop app', $xof, devices: 2)]];
        yield 'two groups declared differently' => [[
            Plan::make('Free', Group::make('App'), default: true),
            Plan::make('Pro', Group::make('App', 'other'), price: $xof + ['interval' => 'month']),
        ]];
    }

    /** @param  list<Feature|Plan|Credits|CreditPack|License>  $items */
    #[DataProvider('productTwins')]
    public function test_c8_products_share_one_namespace_across_types_compared_normalised(array $items): void
    {
        $this->expectException(ConfigException::class);
        $this->expectExceptionMessageMatches('/Product ".*" is declared twice/');
        Catalog::document($items);
    }

    public function test_c8_features_whose_names_differ_only_by_case_or_whitespace_are_one_feature(): void
    {
        foreach (['messages', ' MESSAGES ', "Messages\t"] as $twin) {
            try {
                Catalog::document([Feature::metered('Messages'), Feature::metered($twin)]);
                $this->fail("feature \"{$twin}\" was accepted next to \"Messages\"");
            } catch (ConfigException $e) {
                $this->assertStringContainsString('declared twice', $e->getMessage());
            }
        }
    }

    public function test_c8_a_group_shared_by_its_plans_or_named_by_a_string_is_one_product(): void
    {
        $app = Group::make('My App');
        $document = Catalog::document([
            Plan::make('Free', $app, default: true),
            Plan::make('Pro', 'My App', price: ['amount' => 1, 'currency' => 'XOF', 'interval' => 'month']),
        ]);

        $this->assertCount(1, $document['products']);
        $this->assertSame(['Free', 'Pro'], array_column($document['products'][0]['plans'], 'name'));
    }

    public function test_c8_packs_differing_only_by_case_or_whitespace_are_one_pack_and_two_products_are_two_scopes(): void
    {
        $xof = ['amount' => 1, 'currency' => 'XOF'];
        $tokens = Credits::make('AI tokens');
        foreach (['100 TOKENS', ' 100  tokens '] as $twin) {
            try {
                Catalog::document([CreditPack::make('100 tokens', $tokens, 100, $xof), CreditPack::make($twin, $tokens, 200, $xof)]);
                $this->fail("pack \"{$twin}\" was accepted next to \"100 tokens\"");
            } catch (ConfigException $e) {
                $this->assertStringContainsString("Credit pack \"{$twin}\" is declared twice in \"AI tokens\"", $e->getMessage());
            }
        }
        $document = Catalog::document([
            CreditPack::make('100 tokens', $tokens, 100, $xof),
            CreditPack::make('100 tokens', Credits::make('Image credits'), 100, $xof),
        ]);
        $this->assertSame(['AI tokens', 'Image credits'], array_column($document['products'], 'name'));
    }

    public function test_c8_plans_differing_only_by_case_or_inner_whitespace_are_one_plan(): void
    {
        $this->expectException(ConfigException::class);
        $this->expectExceptionMessage('declared twice in group "app"');
        Catalog::document([
            Plan::make('Pro  Plus', 'app', default: true),
            Plan::make('pro plus', 'app', price: ['amount' => 1, 'currency' => 'XOF', 'interval' => 'month']),
        ]);
    }

    public function test_c8_the_same_plan_name_in_two_groups_is_two_plans(): void
    {
        $document = Catalog::document([
            Plan::make('Pro', Group::make('My App'), price: ['amount' => 1, 'currency' => 'XOF', 'interval' => 'month']),
            Plan::make('Pro', Group::make('My API'), price: ['amount' => 2, 'currency' => 'XOF', 'interval' => 'month']),
        ]);

        $this->assertSame(['My App', 'My API'], array_column($document['products'], 'name'));
        $this->assertSame(['Pro'], array_column($document['products'][0]['plans'], 'name'));
        $this->assertSame(['Pro'], array_column($document['products'][1]['plans'], 'name'));
    }

    public function test_normalize_composes_trims_collapses_and_lowercases(): void
    {
        $this->assertSame('ai tokens', Support::normalize("  AI \t  TOKENS "));
        // "é" typed as e + combining acute is the same name as the precomposed "É".
        $this->assertSame(Support::normalize("Cafe\u{0301}"), Support::normalize("CAF\u{00C9}"));
    }
}
