<?php

namespace Itaja\Laravel\Catalog;

/**
 * The catalogue in code → the canonical document `PUT /v1/catalog` takes
 * (`spec/catalog.schema.json`). Deterministic: the same declaration gives the
 * same JSON, in declaration order, in every language.
 *
 * Every item is identified by its NAME, compared trimmed, inner whitespace
 * collapsed and case-insensitively. Refused locally, as the API would: two
 * features of one name, two products of one name (whatever their types), two
 * plans of one name in a group, two packs of one name in a credits product,
 * and a plan including a feature the catalogue does not declare.
 */
final class Catalog
{
    /**
     * @param  iterable<Feature|Plan|Credits|CreditPack|License>  $items
     * @return array{features: list<array{name: string, type: string}>, products: list<array<string, mixed>>}
     */
    public static function document(iterable $items): array
    {
        /** @var array<string, Feature> $features */
        $features = [];
        /** @var array<string, array{kind: string, decl: Group|Credits|License, plans: list<Plan>, packs: list<CreditPack>}> $products */
        $products = [];

        // By reference: the closure must see, and add to, the products found so far.
        $product = static function (string $kind, Group|Credits|License $decl) use (&$products): string {
            $key = Support::normalize($decl->name);
            if (! isset($products[$key])) {
                $products[$key] = ['kind' => $kind, 'decl' => $decl, 'plans' => [], 'packs' => []];

                return $key;
            }
            $known = $products[$key];
            // The same product reached twice (a group shared by its plans, credits
            // and their packs) is one product; two declarations of one name are refused.
            if ($known['kind'] === $kind && $kind !== 'license' && $known['decl'] == $decl) {
                return $key;
            }
            throw Support::error("Product \"{$decl->name}\" is declared twice (same name as \"{$known['decl']->name}\"): product names are unique across subscriptions, credits and licences, compared trimmed and case-insensitively.");
        };

        foreach ($items as $item) {
            switch (true) {
                case $item instanceof Feature:
                    $key = Support::normalize($item->name);
                    if (isset($features[$key]) && $features[$key] != $item) {
                        throw Support::error("Feature \"{$item->name}\" is declared twice (same name as \"{$features[$key]->name}\": feature names are compared trimmed and case-insensitively).");
                    }
                    $features[$key] = $item;
                    break;

                case $item instanceof Plan:
                    $key = $product('group', $item->group);
                    $groupName = $products[$key]['decl']->name;
                    foreach ($products[$key]['plans'] as $existing) {
                        if ($existing->key() === $item->key()) {
                            throw Support::error("Plan \"{$item->name}\" is declared twice in group \"{$groupName}\" (same name as \"{$existing->name}\": plan names are compared trimmed and case-insensitively).");
                        }
                        if ($item->default && $existing->default) {
                            throw Support::error("Group \"{$groupName}\" has two default plans; keep one.");
                        }
                    }
                    $products[$key]['plans'][] = $item;
                    break;

                case $item instanceof Credits:
                case $item instanceof CreditPack:
                    $key = $product('credits', $item instanceof Credits ? $item : $item->of);
                    if ($item instanceof CreditPack) {
                        $creditsName = $products[$key]['decl']->name;
                        foreach ($products[$key]['packs'] as $existing) {
                            if (Support::normalize($existing->name) === Support::normalize($item->name)) {
                                throw Support::error("Credit pack \"{$item->name}\" is declared twice in \"{$creditsName}\" (same name as \"{$existing->name}\": pack names are compared trimmed and case-insensitively).");
                            }
                        }
                        $products[$key]['packs'][] = $item;
                    }
                    break;

                case $item instanceof License:
                    $product('license', $item);
                    break;

                default:
                    throw Support::error('The catalogue accepts Feature, Plan, Credits, CreditPack and License items only.');
            }
        }

        $out = [];
        foreach ($products as ['decl' => $decl, 'plans' => $plans, 'packs' => $packs]) {
            if ($decl instanceof Group) {
                foreach ($plans as $plan) {
                    foreach ($plan->includes as $inclusion) {
                        if (! isset($features[Support::normalize($inclusion['feature'])])) {
                            throw Support::error("Plan \"{$plan->name}\" includes feature \"{$inclusion['feature']}\", which the catalogue does not declare. Add the feature to the catalogue.");
                        }
                    }
                }
                $out[] = array_filter([
                    'type' => 'subscription',
                    'name' => $decl->name,
                    'description' => $decl->description,
                    'plans' => array_map(fn (Plan $p): array => array_filter([
                        'name' => $p->name,
                        'description' => $p->description,
                        'default' => $p->default ? true : null,
                        'trial' => $p->trialDays !== null ? ['days' => $p->trialDays] : null,
                        'price' => $p->price,
                        'includes' => $p->includes,
                    ], fn ($v) => $v !== null), $plans),
                ], fn ($v) => $v !== null);
            } elseif ($decl instanceof Credits) {
                if ($packs === []) {
                    throw Support::error("Credits \"{$decl->name}\" has no pack: declare at least one CreditPack for it.");
                }
                $out[] = array_filter([
                    'type' => 'credits',
                    'name' => $decl->name,
                    'description' => $decl->description,
                    'coinName' => $decl->coinName,
                    'packs' => array_map(fn (CreditPack $p): array => array_filter([
                        'name' => $p->name,
                        'description' => $p->description,
                        'credits' => $p->credits,
                        'price' => $p->price,
                    ], fn ($v) => $v !== null), $packs),
                ], fn ($v) => $v !== null);
            } else {
                $out[] = array_filter([
                    'type' => 'license',
                    'name' => $decl->name,
                    'description' => $decl->description,
                    'devices' => $decl->devices,
                    'duration' => $decl->duration,
                    'price' => $decl->price,
                ], fn ($v, $k) => $v !== null || $k === 'devices', ARRAY_FILTER_USE_BOTH);
            }
        }

        return [
            'features' => array_values(array_map(fn (Feature $f): array => ['name' => $f->name, 'type' => $f->type], $features)),
            'products' => $out,
        ];
    }
}
