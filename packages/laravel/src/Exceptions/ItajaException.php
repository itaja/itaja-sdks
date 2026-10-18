<?php

namespace Itaja\Laravel\Exceptions;

use RuntimeException;

/**
 * One hierarchy for everything the SDK can fail on. Branch on `errorCode`
 * (the API's stable code), never on the message. No exception ever carries the
 * API key or the webhook secret.
 */
class ItajaException extends RuntimeException
{
    /**
     * @param  array<string, mixed>|null  $details
     */
    public function __construct(
        string $message,
        public readonly string $errorCode,
        public readonly int $status = 0,
        public readonly ?string $requestId = null,
        public readonly ?array $details = null,
    ) {
        parent::__construct($message, $status);
    }

    /**
     * @param  array<string, mixed>|null  $details
     */
    public static function forStatus(
        int $status,
        string $message,
        string $errorCode,
        ?string $requestId = null,
        ?array $details = null,
        ?int $retryAfterSeconds = null,
    ): self {
        return match (true) {
            $status === 400, $status === 422 => new ValidationException($message, $errorCode, $status, $requestId, $details),
            $status === 401 => new AuthenticationException($message, $errorCode, $status, $requestId, $details),
            $status === 403 => new PermissionException($message, $errorCode, $status, $requestId, $details),
            $status === 404 => new NotFoundException($message, $errorCode, $status, $requestId, $details),
            $status === 409 => new ConflictException($message, $errorCode, $status, $requestId, $details),
            $status === 429 => new RateLimitException($message, $errorCode, $status, $requestId, $details, $retryAfterSeconds),
            $status >= 500 => new ServerException($message, $errorCode, $status, $requestId, $details),
            default => new self($message, $errorCode, $status, $requestId, $details),
        };
    }
}
