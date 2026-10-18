<?php

use Itaja\Laravel\Catalog\Feature;
use Itaja\Laravel\Catalog\Group;
use Itaja\Laravel\Catalog\Plan;

$messages = Feature::metered('messages');
$app = Group::make('app', 'My App');

return [
    $messages,
    Plan::make('free', $app, default: true, includes: [$messages(limit: 100, reset: 'month')]),
    Plan::make('pro', $app, price: ['amount' => 5000, 'currency' => 'XOF', 'interval' => 'month'], includes: [$messages(limit: 2000, reset: 'month')]),
];
