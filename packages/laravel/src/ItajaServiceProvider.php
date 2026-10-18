<?php

namespace Itaja\Laravel;

use Illuminate\Contracts\Cache\Factory as CacheFactory;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use Itaja\Laravel\Console\PushCommand;
use Itaja\Laravel\Console\StatusCommand;
use Itaja\Laravel\Console\TriggerCommand;
use Itaja\Laravel\Http\Transport;
use Itaja\Laravel\Http\WebhookController;
use Itaja\Laravel\Webhooks\Dedupe;
use Itaja\Laravel\Webhooks\Processor;
use Itaja\Laravel\Webhooks\Signature;
use Throwable;

class ItajaServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/itaja.php', 'itaja');

        $this->app->singleton(Itaja::class, fn (Application $app): Itaja => new Itaja($app, (array) $app['config']->get('itaja')));
        $this->app->alias(Itaja::class, 'itaja');

        $this->app->singleton(Processor::class, function (Application $app): Processor {
            $config = (array) $app['config']->get('itaja');
            $store = $config['webhook']['dedupe_store'] ?? null;

            return new Processor(
                $app->make(Dispatcher::class),
                new Dedupe($app->make(CacheFactory::class)->store($store)),
                (string) ($config['webhook_secret'] ?? ''),
                Transport::modeOfKey($config['api_key'] ?? null),
                (int) ($config['webhook']['tolerance'] ?? Signature::DEFAULT_TOLERANCE),
                static function (Throwable $e): void {
                    report($e);
                },
            );
        });
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->publishes([__DIR__.'/../config/itaja.php' => config_path('itaja.php')], 'itaja-config');
            $this->commands([PushCommand::class, StatusCommand::class, TriggerCommand::class]);
        }

        $path = $this->app['config']->get('itaja.webhook.path');
        if (is_string($path) && $path !== '' && ! $this->app->routesAreCached()) {
            Route::post($path, WebhookController::class)
                ->middleware((array) $this->app['config']->get('itaja.webhook.middleware', []))
                ->withoutMiddleware([\Illuminate\Foundation\Http\Middleware\VerifyCsrfToken::class])
                ->name('itaja.webhook');
        }
    }
}
