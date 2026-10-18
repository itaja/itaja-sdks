<?php

namespace Itaja\Laravel\Exceptions;

/** 5xx — Itaja or a provider behind it failed. Safe calls were already retried. */
class ServerException extends ItajaException
{
}
