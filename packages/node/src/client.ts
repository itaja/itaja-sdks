/**
 * `createItaja` — the one object a merchant's server holds (ADR 0015 D1).
 *
 * ```ts
 * export const itaja = createItaja({
 *   catalog: [messages, free, pro, tokens, small],
 *   on: { "checkout.paid": ({ data }) => fulfil(data.checkoutId) },
 * });
 * ```
 *
 * Products are named by **your** catalogue ids (`"tokens"`), never by Itaja's:
 * the SDK resolves them once against the products your last `push` created.
 */
import type { ApiPath, RequestBody, RequestQuery, ResponseData } from "./api-types.js";
import {
  type CatalogDocument,
  type CatalogItem,
  type CreditsIdOf,
  type LicenseIdOf,
  type PlanIdOf,
  type ProductIdOf,
  toCatalogDocument,
} from "./catalog.js";
import { ItajaConfigError, ItajaError, ItajaNotFoundError } from "./errors.js";
import {
  type DedupeStore,
  type EventHandlers,
  createWebhookHandler,
  memoryDedupeStore,
  toNodeHandler,
} from "./handler.js";
import { type KeyMode, Transport, type TransportOptions } from "./transport.js";

export interface ItajaOptions<C extends readonly CatalogItem[]> {
  /** What you sell, declared with `plan`, `creditPack`, `license`, `feature`. */
  catalog?: C;
  /** Defaults to `process.env.ITAJA_API_KEY`. Server-side only. */
  apiKey?: string;
  /** Defaults to `process.env.ITAJA_WEBHOOK_SECRET`. Needed only to mount the handler. */
  webhookSecret?: string;
  /** Defaults to `process.env.ITAJA_API_URL`, then `https://api.getitaja.com/api/v1`. */
  baseUrl?: string;
  /** Typed reactions to Itaja's events. */
  on?: EventHandlers;
  /** Where processed event ids are kept. In memory by default. */
  dedupe?: DedupeStore;
  timeoutMs?: number;
  maxRetries?: number;
  /** For tests. */
  transport?: Pick<TransportOptions, "http" | "sleep">;
}

/** A product named by your catalogue id, or — for products made in the dashboard — by its Itaja id. */
export type ProductRef<K extends string> = { product: K } | { productId: string };

type Data<P extends ApiPath, M extends "get" | "post" | "put" | "patch" | "delete"> = ResponseData<P, M>;

export type PushResult = Data<"/catalog", "put">;

export interface Itaja<C extends readonly CatalogItem[]> {
  /** The API key's mode: `sandbox` (`itjs_`) or `live` (`itjp_`). */
  readonly mode: KeyMode;
  /** The canonical catalogue document `push` sends. */
  readonly catalog: CatalogDocument;

  /** Syncs the catalogue. `dryRun` returns the diff without writing. */
  push(options?: { dryRun?: boolean; idempotencyKey?: string }): Promise<PushResult>;

  /** Web-standard webhook handler: mount it on `POST /itaja/webhook`. */
  readonly handler: (request: Request) => Promise<Response>;
  /** The same handler for Express / `node:http`. */
  readonly nodeHandler: ReturnType<typeof toNodeHandler>;

  readonly customers: {
    create(input: RequestBody<"/customers", "post">, options?: WriteOptions): Promise<Data<"/customers", "post">>;
    /** `customerId` is Itaja's id or **your** `merchantCustomerId`. */
    get(customerId: string): Promise<Data<"/customers/{customerId}", "get">>;
    update(
      customerId: string,
      input: RequestBody<"/customers/{customerId}", "patch">,
      options?: WriteOptions,
    ): Promise<Data<"/customers/{customerId}", "patch">>;
    list(query?: RequestQuery<"/customers", "get">): Promise<Data<"/customers", "get">>;
    invoices(customerId: string): Promise<Data<"/customers/{customerId}/invoices", "get">>;
  };

  readonly checkout: {
    /** A cart you price yourself. Returns the `checkoutUrl` to send the buyer to. */
    create(input: RequestBody<"/checkout-sessions", "post">, options?: WriteOptions): Promise<Data<"/checkout-sessions", "post">>;
  };

  readonly credits: {
    grant(input: CreditMoveInput<CreditsIdOf<C>> & { expiresAt?: string | null; lowBalanceThreshold?: number }, options?: WriteOptions): Promise<Data<"/products/{productId}/credits/grant", "post">>;
    /** Refuses, writing nothing, when the balance is short. */
    consume(input: CreditMoveInput<CreditsIdOf<C>>, options?: WriteOptions): Promise<Data<"/products/{productId}/credits/consume", "post">>;
    balance(input: CreditRef<CreditsIdOf<C>>): Promise<Data<"/products/{productId}/credits/{customerId}/balance", "get">>;
    wallet(input: CreditRef<CreditsIdOf<C>> & { limit?: number }): Promise<Data<"/products/{productId}/credits/{customerId}", "get">>;
    /** A 15-minute token the buyer's device spends with, without your key. */
    walletToken(input: CreditRef<CreditsIdOf<C>>): Promise<Data<"/products/{productId}/credits/{customerId}/wallet-token", "post">>;
    packs(ref: ProductRef<CreditsIdOf<C>>): Promise<Data<"/products/{productId}/credit-packs", "get">>;
    /** Sells a declared pack: returns the checkout to send the buyer to. */
    buy(
      input: ProductRef<CreditsIdOf<C>> & { pack: string; customerId: string; homeUrl: string; reference?: string; language?: string },
      options?: WriteOptions,
    ): Promise<Data<"/products/{productId}/credit-packs/{packId}/checkout", "post">>;
  };

  readonly licenses: {
    issue(input: ProductRef<LicenseIdOf<C>> & RequestBody<"/products/{productId}/licenses", "post">, options?: WriteOptions): Promise<Data<"/products/{productId}/licenses", "post">>;
    list(input: ProductRef<LicenseIdOf<C>> & RequestQuery<"/products/{productId}/licenses", "get">): Promise<Data<"/products/{productId}/licenses", "get">>;
    get(input: ProductRef<LicenseIdOf<C>> & { keyId: string }): Promise<Data<"/products/{productId}/licenses/{keyId}", "get">>;
    revoke(input: ProductRef<LicenseIdOf<C>> & { keyId: string; reason?: string }, options?: WriteOptions): Promise<Data<"/products/{productId}/licenses/{keyId}/revoke", "post">>;
    suspend(input: ProductRef<LicenseIdOf<C>> & { keyId: string }, options?: WriteOptions): Promise<Data<"/products/{productId}/licenses/{keyId}/suspend", "post">>;
    resume(input: ProductRef<LicenseIdOf<C>> & { keyId: string }, options?: WriteOptions): Promise<Data<"/products/{productId}/licenses/{keyId}/resume", "post">>;
    rotate(input: ProductRef<LicenseIdOf<C>> & { keyId: string }, options?: WriteOptions): Promise<Data<"/products/{productId}/licenses/{keyId}/rotate", "post">>;
    resend(input: ProductRef<LicenseIdOf<C>> & { keyId: string }, options?: WriteOptions): Promise<Data<"/products/{productId}/licenses/{keyId}/resend", "post">>;
  };

  readonly subscriptions: {
    list(query?: RequestQuery<"/subscriptions", "get">): Promise<Data<"/subscriptions", "get">>;
    get(subscriptionId: string): Promise<Data<"/subscriptions/{subscriptionId}", "get">>;
    cancel(subscriptionId: string, input?: { immediately?: boolean }, options?: WriteOptions): Promise<Data<"/subscriptions/{subscriptionId}/cancel", "post">>;
    pause(subscriptionId: string, options?: WriteOptions): Promise<Data<"/subscriptions/{subscriptionId}/pause", "post">>;
    resume(subscriptionId: string, options?: WriteOptions): Promise<Data<"/subscriptions/{subscriptionId}/resume", "post">>;
  };

  /**
   * One call for new, upgrade, downgrade, cancel-to-free and resume (ADR 0015 D4).
   * **Not served by the API yet** (itaja/itaja-services#465): throws `NOT_YET_AVAILABLE`.
   */
  subscribe(input: { customerId: string; plan: PlanIdOf<C>; successUrl?: string; cancelUrl?: string }): Promise<never>;
  /** Is this customer entitled to a feature? **Not served yet** (#466). */
  check(input: { customerId: string; feature: string }): Promise<never>;
  /** Count usage against a metered feature. **Not served yet** (#466). */
  report(input: { customerId: string; feature: string; amount?: number }): Promise<never>;

  /** The raw escape hatch: any developer-API route, envelope unwrapped, errors typed. */
  request<T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, options?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; idempotencyKey?: string }): Promise<T>;
}

export interface WriteOptions {
  /** Reuse it to make your own retry of this call safe. The SDK makes one per call otherwise. */
  idempotencyKey?: string;
}

type CreditRef<K extends string> = ProductRef<K> & { customerId: string };
type CreditMoveInput<K extends string> = CreditRef<K> & { amount: number; reason?: string | null };

export function createItaja<const C extends readonly CatalogItem[] = []>(options: ItajaOptions<C> = {}): Itaja<C> {
  const env = typeof process !== "undefined" ? process.env : {};
  const apiKey = options.apiKey ?? env.ITAJA_API_KEY ?? "";
  const webhookSecret = options.webhookSecret ?? env.ITAJA_WEBHOOK_SECRET ?? "";
  const items = (options.catalog ?? []) as readonly CatalogItem[];
  const catalog = toCatalogDocument(items);

  // The transport is built on first use: a CLI that only prints the catalogue,
  // or a test of the handler, needs no API key.
  let transport: Transport | null = null;
  const http = () =>
    (transport ??= new Transport({
      apiKey,
      baseUrl: options.baseUrl ?? env.ITAJA_API_URL,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      ...options.transport,
    }));
  const mode: KeyMode = apiKey.startsWith("itjs_") ? "sandbox" : "live";

  // Your catalogue ids → Itaja product ids, read from the products a push created.
  let productIds: Map<string, string> | null = null;
  const loadProducts = async () => {
    const products = await http().request<Array<{ id: string; catalogKey?: string | null }>>({
      method: "GET",
      path: "/products",
    });
    productIds = new Map(products.filter((p) => p.catalogKey).map((p) => [p.catalogKey as string, p.id]));
    return productIds;
  };
  const productId = async (ref: ProductRef<string>): Promise<string> => {
    if ("productId" in ref) return ref.productId;
    const known = (productIds ?? (await loadProducts())).get(ref.product);
    if (known) return known;
    const fresh = (await loadProducts()).get(ref.product);
    if (fresh) return fresh;
    throw new ItajaNotFoundError({
      message: `Product "${ref.product}" is not in your ${mode} Itaja catalogue. Run \`itaja push\` with this key first.`,
      code: "CATALOG_PRODUCT_NOT_PUSHED",
      status: 404,
    });
  };
  const seg = encodeURIComponent;

  let handler: ((request: Request) => Promise<Response>) | null = null;
  const webhookHandler = (request: Request) => {
    if (!webhookSecret) {
      throw new ItajaConfigError({
        message: "No webhook secret. Set ITAJA_WEBHOOK_SECRET, or pass webhookSecret.",
        code: "WEBHOOK_SECRET_MISSING",
        status: 0,
      });
    }
    handler ??= createWebhookHandler({
      secret: webhookSecret,
      mode,
      on: options.on ?? {},
      dedupe: options.dedupe ?? memoryDedupeStore(),
    });
    return handler(request);
  };

  const notYet = (what: string, issue: number) =>
    Promise.reject(
      new ItajaError({
        message: `${what} is not served by the Itaja API yet (itaja/itaja-services#${issue}).`,
        code: "NOT_YET_AVAILABLE",
        status: 0,
      }),
    );

  const write = <T>(method: "POST" | "PUT" | "PATCH", path: string, body: unknown, opts?: WriteOptions) =>
    http().request<T>({ method, path, body, idempotencyKey: opts?.idempotencyKey });
  const read = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    http().request<T>({ method: "GET", path, query });

  /** Credits take their own body `idempotencyKey`; the SDK sends the header's, so a retry is one movement. */
  const creditMove = async (kind: "grant" | "consume", input: CreditMoveInput<string> & Record<string, unknown>, opts?: WriteOptions) => {
    const { product: _p, productId: _id, ...body } = input as Record<string, unknown>;
    const key = opts?.idempotencyKey ?? crypto.randomUUID();
    return http().request<never>({
      method: "POST",
      path: `/products/${seg(await productId(input))}/credits/${kind}`,
      body: { ...body, idempotencyKey: key },
      idempotencyKey: key,
    });
  };
  const licensePath = async (input: ProductRef<string> & { keyId?: string }, tail = "") =>
    `/products/${seg(await productId(input))}/licenses${input.keyId ? `/${seg(input.keyId)}` : ""}${tail}`;

  return {
    mode,
    catalog,
    push: (opts = {}) =>
      http().request({
        method: "PUT",
        path: "/catalog",
        query: opts.dryRun ? { dryRun: "true" } : undefined,
        body: catalog,
        idempotencyKey: opts.idempotencyKey,
      }).then((result) => {
        if (!opts.dryRun) productIds = null; // a push may have created products
        return result as PushResult;
      }),
    handler: webhookHandler,
    nodeHandler: toNodeHandler(webhookHandler),

    customers: {
      create: (input, opts) => write("POST", "/customers", input, opts),
      get: (id) => read(`/customers/${seg(id)}`),
      update: (id, input, opts) => write("PATCH", `/customers/${seg(id)}`, input, opts),
      list: (query) => read("/customers", query as Record<string, string | number | undefined>),
      invoices: (id) => read(`/customers/${seg(id)}/invoices`),
    },

    checkout: {
      create: (input, opts) => write("POST", "/checkout-sessions", input, opts),
    },

    credits: {
      grant: (input, opts) => creditMove("grant", input, opts),
      consume: (input, opts) => creditMove("consume", input, opts),
      balance: async (input) => read(`/products/${seg(await productId(input))}/credits/${seg(input.customerId)}/balance`),
      wallet: async (input) =>
        read(`/products/${seg(await productId(input))}/credits/${seg(input.customerId)}`, { limit: input.limit }),
      walletToken: async (input, ) =>
        write("POST", `/products/${seg(await productId(input))}/credits/${seg(input.customerId)}/wallet-token`, undefined),
      packs: async (ref) => read(`/products/${seg(await productId(ref))}/credit-packs`),
      buy: async (input, opts) => {
        const pid = await productId(input);
        const packs = await read<{ packs: Array<{ id: string; catalogKey?: string | null }> }>(`/products/${seg(pid)}/credit-packs`);
        const pack = packs.packs.find((p) => p.catalogKey === input.pack || p.id === input.pack);
        if (!pack) {
          throw new ItajaNotFoundError({
            message: `Credit pack "${input.pack}" is not on sale for this product.`,
            code: "CREDIT_PACK_NOT_FOUND",
            status: 404,
          });
        }
        const { customerId, homeUrl, reference, language } = input;
        return write("POST", `/products/${seg(pid)}/credit-packs/${seg(pack.id)}/checkout`, { customerId, homeUrl, reference, language }, opts);
      },
    },

    licenses: {
      issue: async (input, opts) => {
        const { product: _p, productId: _id, ...body } = input as Record<string, unknown>;
        return write("POST", await licensePath(input), body, opts);
      },
      list: async (input) => {
        const { limit, cursor } = input as { limit?: number; cursor?: string };
        return read(await licensePath(input), { limit, cursor });
      },
      get: async (input) => read(await licensePath(input)),
      revoke: async (input, opts) => write("POST", await licensePath(input, "/revoke"), { reason: input.reason }, opts),
      suspend: async (input, opts) => write("POST", await licensePath(input, "/suspend"), undefined, opts),
      resume: async (input, opts) => write("POST", await licensePath(input, "/resume"), undefined, opts),
      rotate: async (input, opts) => write("POST", await licensePath(input, "/rotate"), undefined, opts),
      resend: async (input, opts) => write("POST", await licensePath(input, "/resend"), undefined, opts),
    },

    subscriptions: {
      list: (query) => read("/subscriptions", query as Record<string, string | undefined>),
      get: (id) => read(`/subscriptions/${seg(id)}`),
      cancel: (id, input = {}, opts) => write("POST", `/subscriptions/${seg(id)}/cancel`, input, opts),
      pause: (id, opts) => write("POST", `/subscriptions/${seg(id)}/pause`, undefined, opts),
      resume: (id, opts) => write("POST", `/subscriptions/${seg(id)}/resume`, undefined, opts),
    },

    subscribe: () => notYet("subscribe()", 465),
    check: () => notYet("check()", 466),
    report: () => notYet("report()", 466),

    request: (method, path, opts = {}) => http().request({ method, path, ...opts }),
  } as Itaja<C>;
}

/** The ids your catalogue declares, for your own signatures. */
export type { PlanIdOf, CreditsIdOf, LicenseIdOf, ProductIdOf };
