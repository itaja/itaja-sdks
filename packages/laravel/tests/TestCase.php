<?php

namespace Itaja\Laravel\Tests;

use Itaja\Laravel\ItajaServiceProvider;
use Orchestra\Testbench\TestCase as Orchestra;

abstract class TestCase extends Orchestra
{
    protected const SPEC = __DIR__.'/../../../spec';

    protected function getPackageProviders($app): array
    {
        return [ItajaServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('itaja.api_key', 'itjs_test_key_for_unit_tests');
        $app['config']->set('itaja.webhook_secret', 'whsec_test');
        $app['config']->set('cache.default', 'array');
    }

    /** @return array<string, mixed> */
    protected static function spec(string $file): array
    {
        return json_decode((string) file_get_contents(self::SPEC.'/'.$file), true, 512, JSON_THROW_ON_ERROR);
    }
}
