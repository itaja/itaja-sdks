<?php

namespace Itaja\Laravel;

use Closure;
use Illuminate\Contracts\Container\Container;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Str;
use Itaja\Laravel\Catalog\Catalog;
use Itaja\Laravel\Exceptions\ConfigException;
use Itaja\Laravel\Exceptions\ItajaException;
use Itaja\Laravel\Exceptions\NotFoundException;
use Itaja\Laravel\Http\Transport;

/**
 * The one object your server holds. Resolve it from the container, or use the
 * `Itaja` facade:
 *
 *     Itaja::push();
 *     Itaja::credits()->consume(product: 'tokens', customerId: $id, amount: 3);
 *
 * Products are named by YOUR catalogue ids ('tokens'), never by Itaja's: the
 * SDK resolves them once against the products your last `itaja:push` created.
 * A product made in the dashboard is named by its Itaja id instead
 * (`productId: 'prd_…'`).
 */
final class Itaja
{
    /** @var array<string, string>|null catalogue id → Itaja product id */
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
     * Not served by the API yet (itaja/itaja-services#465).
     */
    public function subscribe(string $customerId, string $plan, ?string $successUrl = null, ?string $cancelUrl = null): never
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

    /** @return Closure(?string, ?string): string */
    private function resolver(): Closure
    {
        return function (?string $product, ?string $productId): string {
            if ($productId !== null) {
                return $productId;
            }
            if ($product === null) {
                throw new ConfigException('Name the product: product: \'your-catalogue-id\' or productId: \'prd_…\'.', 'PRODUCT_MISSING', 0);
            }
            $known = ($this->productIds ?? $this->loadProducts())[$product] ?? ($this->loadProducts())[$product] ?? null;
            if ($known !== null) {
                return $known;
            }
            throw new NotFoundException(
                "Product \"{$product}\" is not in your {$this->mode()} Itaja catalogue. Run `php artisan itaja:push` with this key first.",
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
                $map[(string) $product['catalogKey']] = $product['id'];
            }
        }

        return $this->productIds = $map;
    }

    private function notYet(string $what, int $issue): ItajaException
    {
        return new ItajaException("{$what} is not served by the Itaja API yet (itaja/itaja-services#{$issue}).", 'NOT_YET_AVAILABLE', 0);
    }
}
