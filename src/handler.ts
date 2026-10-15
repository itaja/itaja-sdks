/**
 * The one route you mount (ADR 0015 D6). It verifies the signature on the raw
 * body, drops a delivery it already processed, ignores an event of the other
 * mode, calls your typed `on` handlers, and answers so Itaja redelivers when a
 * handler failed.
 *
 * It speaks the Web `Request` / `Response` standard, so it mounts as is on
 * Next.js route handlers, Hono, Bun, Deno, Elysia, Cloudflare Workers — and on
 * Express or `node:http` through `toNodeHandler`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ItajaSignatureError } from "./errors.js";
import type { KeyMode } from "./transport.js";
import { type AnyItajaEvent, type EventType, type ItajaEvent, constructEvent } from "./webhooks.js";

export type EventHandler<E> = (event: E) => unknown | Promise<unknown>;

/** `on`: one handler per event type you care about; `"*"` receives every delivery, known type or not. */
export type EventHandlers = { [T in EventType]?: EventHandler<ItajaEvent<T>> } & {
  "*"?: EventHandler<AnyItajaEvent>;
};

/**
 * Where processed event ids are kept so a redelivery is not handled twice. The
 * default keeps them in memory — enough for one process. Behind several
 * instances, give a shared store (Redis, your database) with the same two calls.
 */
export interface DedupeStore {
  /** `true` when this event id was already processed. */
  has(eventId: string): Promise<boolean> | boolean;
  /** Called once every handler of the event has succeeded. */
  add(eventId: string): Promise<void> | void;
}

/** In-memory, bounded (oldest dropped first), entries kept 24 h by default. */
export function memoryDedupeStore(options: { max?: number; ttlMs?: number } = {}): DedupeStore {
  const max = options.max ?? 10_000;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const seen = new Map<string, number>();
  return {
    has(eventId) {
      const at = seen.get(eventId);
      if (at === undefined) return false;
      if (Date.now() - at > ttlMs) {
        seen.delete(eventId);
        return false;
      }
      return true;
    },
    add(eventId) {
      seen.delete(eventId);
      seen.set(eventId, Date.now());
      while (seen.size > max) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    },
  };
}

export interface WebhookHandlerOptions {
  secret: string;
  /** The mode of your API key: an event of the other mode is acknowledged and ignored. */
  mode: KeyMode;
  on: EventHandlers;
  dedupe?: DedupeStore;
  toleranceSeconds?: number;
  /** Called when a handler throws; the delivery is answered 500 and retried by Itaja. */
  onError?: (error: unknown, event: AnyItajaEvent) => void;
}

export type WebhookOutcome = "handled" | "duplicate" | "ignored_mode" | "unhandled" | "invalid_signature" | "handler_failed";

export interface WebhookResult {
  status: 200 | 400 | 405 | 500;
  outcome: WebhookOutcome;
  eventId: string | null;
}

/** The framework-free core: a raw body and headers in, a status out. */
export async function processWebhook(
  input: { payload: string; headers: Headers | Record<string, string | string[] | undefined> },
  options: WebhookHandlerOptions,
): Promise<WebhookResult> {
  let event: AnyItajaEvent;
  try {
    event = constructEvent({
      payload: input.payload,
      headers: input.headers,
      secret: options.secret,
      toleranceSeconds: options.toleranceSeconds,
    });
  } catch (error) {
    if (error instanceof ItajaSignatureError) return { status: 400, outcome: "invalid_signature", eventId: null };
    throw error;
  }

  const dedupe = options.dedupe ?? defaultStore(options);
  if (event.mode !== undefined && event.mode !== options.mode) {
    return { status: 200, outcome: "ignored_mode", eventId: event.id };
  }
  if (await dedupe.has(event.id)) return { status: 200, outcome: "duplicate", eventId: event.id };

  const typed = (options.on as Record<string, EventHandler<AnyItajaEvent> | undefined>)[event.type];
  const all = options.on["*"];
  if (!typed && !all) {
    await dedupe.add(event.id);
    return { status: 200, outcome: "unhandled", eventId: event.id };
  }

  try {
    if (typed) await typed(event);
    if (all) await all(event);
  } catch (error) {
    // Not marked processed: Itaja's redelivery runs the handlers again.
    options.onError?.(error, event);
    return { status: 500, outcome: "handler_failed", eventId: event.id };
  }

  await dedupe.add(event.id);
  return { status: 200, outcome: "handled", eventId: event.id };
}

const stores = new WeakMap<WebhookHandlerOptions, DedupeStore>();
function defaultStore(options: WebhookHandlerOptions): DedupeStore {
  let store = stores.get(options);
  if (!store) {
    store = memoryDedupeStore();
    stores.set(options, store);
  }
  return store;
}

/** A Web-standard handler: `(request) => Response`. */
export function createWebhookHandler(options: WebhookHandlerOptions): (request: Request) => Promise<Response> {
  const resolved = { ...options, dedupe: options.dedupe ?? memoryDedupeStore() };
  return async (request) => {
    if (request.method !== "POST") return json(405, { received: false, error: "Method not allowed" });
    const result = await processWebhook({ payload: await request.text(), headers: request.headers }, resolved);
    return json(result.status, { received: result.status === 200, outcome: result.outcome });
  };
}

/**
 * The same handler for Express or `node:http`. With Express, mount it **before**
 * any JSON body parser on this path, or with `express.raw({ type: "*\/*" })`:
 * the signature is computed on the raw bytes.
 */
export function toNodeHandler(
  handler: (request: Request) => Promise<Response>,
): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const raw = await readRawBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const response = await handler(
      new Request(`http://localhost${req.url ?? "/"}`, {
        method: req.method ?? "POST",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
      }),
    );
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(await response.text());
  };
}

async function readRawBody(req: IncomingMessage & { body?: unknown }): Promise<string> {
  // `express.raw()` already read it into a Buffer.
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body !== undefined && req.body !== null && typeof req.body === "object") {
    throw new ItajaSignatureError({
      message:
        "The request body was already parsed as JSON, so its signature cannot be checked. Mount the Itaja handler before express.json(), or use express.raw({ type: '*/*' }) on its path.",
      code: "RAW_BODY_UNAVAILABLE",
      status: 400,
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
