<?php

namespace Itaja\Laravel\Exceptions;

/** No response — network down, DNS, timeout. Safe calls were already retried. */
class ConnectionException extends ItajaException
{
}
