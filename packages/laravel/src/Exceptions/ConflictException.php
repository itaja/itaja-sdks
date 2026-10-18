<?php

namespace Itaja\Laravel\Exceptions;

/** 409 — the resource's state forbids it (mode mismatch, transition, idempotency key in use). */
class ConflictException extends ItajaException
{
}
