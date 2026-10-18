<?php

namespace Itaja\Laravel\Catalog;

/**
 * The catalogue in code → the canonical document `PUT /v1/catalog` takes
 * (`spec/catalog.schema.json`). Deterministic: the same declaration gives the
 * same JSON, in declaration order, in every language.
 */
final class Catalog
{
    /**
     * @param  iterable<Feature|Plan|Credits|CreditPack|License>  $items
     * @return array{features: list<array{id: string, type: string}>, products: list<array<string, mixed>>}
     */
    public static function document(iterable $items): array
    {
        /** @var array<string, array{id: string, type: string}> $features */
        $features = [];
        /** @var array<string, array{group: Group, plans: list<Plan>}> $groups */
        $groups = [];
        /** @var array<string, array{credits: Credits, packs: list<CreditPack>}> $creditProducts */
        $creditProducts = [];
        /** @var array<string, License> $licenses */
        $licenses = [];
        /** @var list<array{string, string}> $order */
        $order = [];

        // By reference: an arrow function would copy the arrays once, and never see what is added later.
        $taken = static function (string $id) use (&$groups, &$creditProducts, &$licenses): bool {
            return isset($groups[$id]) || isset($creditProducts[$id]) || isset($licenses[$id]);
        };
        $duplicate = static fn (string $id) => Support::error("Product id \"{$id}\" is used twice in the catalogue (groups, credits and licences share one id space).");

        foreach ($items as $item) {
            switch (true) {
                case $item instanceof Feature:
                    if (isset($features[$item->id]) && $features[$item->id]['type'] !== $item->type) {
                        throw Support::error("Feature \"{$item->id}\" is declared twice with different types.");
                    }
                    $features[$item->id] = ['id' => $item->id, 'type' => $item->type];
                    break;

                case $item instanceof Plan:
                    $gid = $item->group->id;
                    if (! isset($groups[$gid])) {
                        if ($taken($gid)) {
                            throw $duplicate($gid);
                        }
                        $groups[$gid] = ['group' => $item->group, 'plans' => []];
                        $order[] = ['group', $gid];
                    } elseif ($groups[$gid]['group']->name !== $item->group->name) {
                        throw Support::error("Group \"{$gid}\" is declared with two different names.");
                    }
                    foreach ($groups[$gid]['plans'] as $existing) {
                        if ($existing->id === $item->id) {
                            throw Support::error("Plan \"{$item->id}\" is declared twice in group \"{$gid}\".");
                        }
                        if ($item->default && $existing->default) {
                            throw Support::error("Group \"{$gid}\" has two default plans; keep one.");
                        }
                    }
                    $groups[$gid]['plans'][] = $item;
                    break;

                case $item instanceof Credits:
                case $item instanceof CreditPack:
                    $credits = $item instanceof Credits ? $item : $item->of;
                    if (! isset($creditProducts[$credits->id])) {
                        if ($taken($credits->id)) {
                            throw $duplicate($credits->id);
                        }
                        $creditProducts[$credits->id] = ['credits' => $credits, 'packs' => []];
                        $order[] = ['credits', $credits->id];
                    }
                    if ($item instanceof CreditPack) {
                        foreach ($creditProducts[$credits->id]['packs'] as $existing) {
                            if ($existing->id === $item->id) {
                                throw Support::error("Credit pack \"{$item->id}\" is declared twice in \"{$credits->id}\".");
                            }
                        }
                        $creditProducts[$credits->id]['packs'][] = $item;
                    }
                    break;

                case $item instanceof License:
                    if ($taken($item->id)) {
                        throw $duplicate($item->id);
                    }
                    $licenses[$item->id] = $item;
                    $order[] = ['license', $item->id];
                    break;

                default:
                    throw Support::error('The catalogue accepts Feature, Plan, Credits, CreditPack and License items only.');
            }
        }

        $products = [];
        foreach ($order as [$kind, $id]) {
            if ($kind === 'group') {
                ['group' => $group, 'plans' => $plans] = $groups[$id];
                foreach ($plans as $plan) {
                    foreach ($plan->includes as $inclusion) {
                        if (! isset($features[$inclusion['feature']])) {
                            throw Support::error("Plan \"{$plan->id}\" includes feature \"{$inclusion['feature']}\", which the catalogue does not declare. Add the feature to the catalogue.");
                        }
                    }
                }
                $products[] = array_filter([
                    'id' => $group->id,
                    'type' => 'subscription',
                    'name' => $group->name,
                    'description' => $group->description,
                    'plans' => array_map(fn (Plan $p): array => array_filter([
                        'id' => $p->id,
                        'name' => $p->name,
                        'description' => $p->description,
                        'price' => $p->price,
                        'trial' => $p->trialDays !== null ? ['days' => $p->trialDays] : null,
                        'default' => $p->default ? true : null,
                        'includes' => $p->includes,
                    ], fn ($v) => $v !== null), $plans),
                ], fn ($v) => $v !== null);
            } elseif ($kind === 'credits') {
                ['credits' => $credits, 'packs' => $packs] = $creditProducts[$id];
                if ($packs === []) {
                    throw Support::error("Credits \"{$credits->id}\" has no pack: declare at least one CreditPack for it.");
                }
                $products[] = array_filter([
                    'id' => $credits->id,
                    'type' => 'credits',
                    'name' => $credits->name,
                    'description' => $credits->description,
                    'coinName' => $credits->coinName,
                    'packs' => array_map(fn (CreditPack $p): array => array_filter([
                        'id' => $p->id,
                        'label' => $p->label,
                        'description' => $p->description,
                        'credits' => $p->credits,
                        'price' => $p->price,
                    ], fn ($v) => $v !== null), $packs),
                ], fn ($v) => $v !== null);
            } else {
                $l = $licenses[$id];
                $products[] = array_filter([
                    'id' => $l->id,
                    'name' => $l->name,
                    'description' => $l->description,
                    'price' => $l->price,
                    'devices' => $l->devices,
                    'duration' => $l->duration,
                    'type' => 'license',
                ], fn ($v, $k) => $v !== null || $k === 'devices', ARRAY_FILTER_USE_BOTH);
            }
        }

        return ['features' => array_values($features), 'products' => $products];
    }
}
