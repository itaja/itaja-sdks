<?php

namespace Itaja\Laravel\Http;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Itaja\Laravel\Webhooks\Processor;

/**
 * The one route Itaja posts to. Mounted for you at `itaja.webhook.path`
 * (default `itaja/webhook`); set the path to null to mount it yourself.
 *
 * It reads the RAW body: the signature is computed on the exact bytes.
 */
final class WebhookController
{
    public function __invoke(Request $request, Processor $processor): JsonResponse
    {
        $headers = [];
        foreach ($request->headers->all() as $name => $values) {
            $headers[$name] = $values;
        }
        $result = $processor->process($request->getContent(), $headers);

        return new JsonResponse(['received' => $result['status'] === 200, 'outcome' => $result['outcome']], $result['status']);
    }
}
