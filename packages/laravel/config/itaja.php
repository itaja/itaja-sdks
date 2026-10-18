<?php

return [
    /*
     | Your secret API key. `itjs_…` acts on the sandbox, `itjp_…` on the live
     | catalogue: the prefix decides, there is no "environment" option.
     | Server side only.
     */
    'api_key' => env('ITAJA_API_KEY'),

    /* The signing secret of your webhook endpoint (dashboard). */
    'webhook_secret' => env('ITAJA_WEBHOOK_SECRET'),

    'base_url' => env('ITAJA_API_URL', 'https://api.getitaja.com/api/v1'),

    /* The file that declares what you sell. It returns an array of items. */
    'catalog' => base_path('itaja.php'),

    'webhook' => [
        /* Set to null to mount the route yourself with Itaja\Laravel\Http\WebhookController. */
        'path' => 'itaja/webhook',
        'middleware' => [],
        'tolerance' => 300,
        /* Cache store that remembers processed event ids (null = the default store). */
        'dedupe_store' => env('ITAJA_DEDUPE_STORE'),
    ],

    'timeout' => 30,
    'retries' => 2,
];
