<?php

namespace Itaja\Laravel;

use Closure;
use Illuminate\Contracts\Container\Container;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Str;
use Itaja\Laravel\Catalog\Catalog;
use Itaja\Laravel\Catalog\Support;
use Itaja\Laravel\Exceptions\ConfigException;
use Itaja\Laravel\Exceptions\ItajaException;
use Itaja\Laravel\Exceptions\NotFoundException;
use Itaja\Laravel\Http\Transport;

/**
 * The one object your server holds. Resolve it from the container, or use the
 * `Itaja` facade:
 *
 *     Itaja::push();
 *     Itaja::credits()->consume(product: 'AI tokens', customerId: $id, amount: 3);
 *
 * Products and packs are referenced by their NAME ('AI tokens'), never by an
 * id: the SDK resolves a name once against the products your last
 * `itaja:push` created, comparing it trimmed, inner spaces collapsed and
 * case-insensitively.
 */
final class Itaja
{
    /** @var array<string, string>|null normalised product name → Itaja product id */
    private ?array $productIds = null;

    /** @var Closure(): iterable<mixed> */
    private Closure $declaration;

    private ?Transport $transport = null;

    /**
     * @param  array<string, mixed>  $config  the `itaja` config
     * @param  (Closure(): iterable<mixed>)|null  $declaration  loads the catalogue items
     * @param  (Closure(int): void)|null  $sleep  milliseconds, replaced in tests
     */
    public function __construct(
        private readonly Container $container,
        private readonly array $config,
        ?Closure $declaration = null,
        private readonly ?Closure $sleep = null,
    ) {
        $this->declaration = $declaration ?? fn (): iterable => $this->loadDeclaration();
    }

    /**
     * Another client with its own key, webhook secret or API URL — for a second
     * Itaja account, a test, or a tenant. Unset values keep this client's
     * configuration (`ITAJA_API_KEY`, `ITAJA_WEBHOOK_SECRET`, `ITAJA_API_URL`).
     *
     *     $tenant = Itaja::with(apiKey: $shop->itaja_key);
     */
    public function with(?string $apiKey = null, ?string $webhookSecret = null, ?string $baseUrl = null): self
    {
        $config = $this->config;
        if ($apiKey !== null) {
            $config['api_key'] = $apiKey;
        }
        if ($webhookSecret !== null) {
            $config['webhook_secret'] = $webhookSecret;
        }
        if ($baseUrl !== null) {
            $config['base_url'] = $baseUrl;
        }

        return new self($this->container, $config, $this->declaration, $this->sleep);
    }

    /** The API key's mode: `sandbox` (`itjs_`) or `live` (`itjp_`). */
    public function mode(): string
    {
        return Transport::modeOfKey($this->config['api_key'] ?? null);
    }

    /**
     * The canonical catalogue document `push` sends.
     *
     * @return array{features: list<array<string, mixed>>, products: list<array<string, mixed>>}
     */
    public function catalog(): array
    {
        return Catalog::document(($this->declaration)());
    }

    /**
     * Syncs the catalogue. `dryRun` returns the diff without writing.
     *
     * @return array<string, mixed>
     */
    public function push(bool $dryRun = false, ?string $idempotencyKey = null): array
    {
        $result = $this->transport()->request('PUT', '/catalog', $dryRun ? ['dryRun' => 'true'] : null, $this->catalog(), $idempotencyKey);
        if (! $dryRun) {
            $this->productIds = null; // a push may have created products
        }

        return $result;
    }

    public function customers(): Resources\Customers
    {
        return new Resources\Customers($this->transport());
    }

    public function checkout(): Resources\Checkout
    {
        return new Resources\Checkout($this->transport());
    }

    public function credits(): Resources\Credits
    {
        return new Resources\Credits($this->transport(), $this->resolver());
    }

    public function licenses(): Resources\Licenses
    {
        return new Resources\Licenses($this->transport(), $this->resolver());
    }

    public function subscriptions(): Resources\Subscriptions
    {
        return new Resources\Subscriptions($this->transport());
    }

    /**
     * One call for new, upgrade, downgrade, cancel-to-free and resume.
     * `$plan` is the plan's NAME as declared (`Plan::make('Pro', ...)`),
     * matched case-insensitively; `$product` (a subscription product's name)
     * picks between products that sell a plan of that name.
     * Not served by the API yet (itaja/itaja-services#465).
     */
    public function subscribe(string $customerId, string $plan, ?string $product = null, ?string $successUrl = null, ?string $cancelUrl = null): never
    {
        throw $this->notYet('subscribe()', 465);
    }

    /** Is this customer entitled to a feature? Not served yet (#466). */
    public function check(string $customerId, string $feature): never
    {
        throw $this->notYet('check()', 466);
    }

    /** Count usage against a metered feature. Not served yet (#466). */
    public function report(string $customerId, string $feature, int $amount = 1): never
    {
        throw $this->notYet('report()', 466);
    }

    /**
     * The raw escape hatch: any developer-API route, envelope unwrapped, errors typed.
     *
     * @param  array<string, scalar|null>|null  $query
     */
    public function request(string $method, string $path, ?array $query = null, mixed $body = null, ?string $idempotencyKey = null): mixed
    {
        return $this->transport()->request(strtoupper($method), $path, $query, $body, $idempotencyKey);
    }

    /** @return iterable<mixed> */
    private function loadDeclaration(): iterable
    {
        $file = $this->config['catalog'] ?? null;
        if (! is_string($file) || ! is_file($file)) {
            throw new ConfigException('No catalogue file. Create itaja.php at the project root (it returns your items), or set `itaja.catalog`.', 'CATALOG_FILE_MISSING', 0);
        }
        $items = require $file;
        if (! is_iterable($items)) {
            throw new ConfigException("{$file} must return an array of catalogue items.", 'CATALOG_DECLARATION_INVALID', 0);
        }

        return $items;
    }

    private function transport(): Transport
    {
        return $this->transport ??= new Transport(
            $this->container->make(Factory::class),
            (string) ($this->config['api_key'] ?? ''),
            (string) ($this->config['base_url'] ?? Transport::DEFAULT_BASE_URL),
            (int) ($this->config['timeout'] ?? 30),
            (int) ($this->config['retries'] ?? 2),
            $this->sleep,
        );
    }

    /** @return Closure(string): string */
    private function resolver(): Closure
    {
        return function (string $product): string {
            $key = Support::normalize($product);
            if ($key === '') {
                throw new ConfigException('A product is referenced by its name: product: \'AI tokens\'.', 'PRODUCT_NAME_MISSING', 0);
            }
            $known = ($this->productIds ?? $this->loadProducts())[$key] ?? ($this->loadProducts())[$key] ?? null;
            if ($known !== null) {
                return $known;
            }
            throw new NotFoundException(
                "No product named \"{$product}\" in your {$this->mode()} Itaja catalogue. Run `php artisan itaja:push` with this key first.",
                'CATALOG_PRODUCT_NOT_PUSHED',
                404,
            );
        };
    }

    /** @return array<string, string> */
    private function loadProducts(): array
    {
        $products = $this->transport()->request('GET', '/products');
        $map = [];
        foreach (is_array($products) ? $products : [] as $product) {
            if (is_array($product) && ! empty($product['catalogKey']) && is_string($product['id'] ?? null)) {
                $map[Support::normalize((string) $product['catalogKey'])] = $product['id'];
            }
        }

        return $this->productIds = $map;
    }

    private function notYet(string $what, int $issue): ItajaException
    {
        return new ItajaException("{$what} is not served by the Itaja API yet (itaja/itaja-services#{$issue}).", 'NOT_YET_AVAILABLE', 0);
    }
}
