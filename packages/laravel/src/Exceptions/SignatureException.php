<?php

namespace Itaja\Laravel\Exceptions;

/** A webhook whose signature, timestamp or body does not check out. */
class SignatureException extends ItajaException
{
}
