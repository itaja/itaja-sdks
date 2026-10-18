<?php

namespace Itaja\Laravel\Exceptions;

/** 429 — slow down; `retryAfterSeconds` says for how long when the API said it. */
class RateLimitException extends ItajaException
{
    /**
     * @param  array<string, mixed>|null  $details
     */
    public function __construct(
        string $message,
        string $errorCode,
        int $status = 429,
        ?string $requestId = null,
        ?array $details = null,
        public readonly ?int $retryAfterSeconds = null,
    ) {
        parent::__construct($message, $errorCode, $status, $requestId, $details);
    }
}
