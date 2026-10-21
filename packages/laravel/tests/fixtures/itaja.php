<?php

use Itaja\Laravel\Catalog\Feature;
use Itaja\Laravel\Catalog\Group;
use Itaja\Laravel\Catalog\Plan;

$messages = Feature::metered('Messages');
$app = Group::make('My App');

return [
    $messages,
    Plan::make('Free', $app, default: true, includes: [$messages(limit: 100, reset: 'month')]),
    Plan::make('Pro', $app, price: ['amount' => 5000, 'currency' => 'XOF', 'interval' => 'month'], includes: [$messages(limit: 2000, reset: 'month')]),
];
