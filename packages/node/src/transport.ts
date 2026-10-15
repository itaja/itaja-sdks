import axios, { type AxiosInstance, isAxiosError } from "axios";
import { randomUUID } from "node:crypto";
import { ItajaConfigError, ItajaConnectionError, ItajaError, errorForStatus } from "./errors.js";
import { SDK_VERSION } from "./version.js";

/**
 * The HTTP layer: one axios instance, the `{ success, data }` envelope
 * unwrapped, typed errors, and retries that can never charge twice.
 *
 * Retry rule (ADR 0015 D8): only a call that is safe to send again is retried —
 * a read, or a write that carries an `Idempotency-Key`. The SDK puts a key on
 * **every** write it sends (one per logical call, reused on each retry), so the
 * API answers a retry with the first response instead of running it again
 * (#462). What is retried: no response, `5xx`, `429`, and
 * `409 IDEMPOTENCY_KEY_IN_PROGRESS`. `Retry-After` is honoured.
 */

export const DEFAULT_BASE_URL = "https://api.getitaja.com/api/v1";

export type KeyMode = "sandbox" | "live";

/** The collection mode a key acts in — the prefix decides, never an option (ADR 0011). */
export function modeOfKey(apiKey: string): KeyMode {
  return apiKey.startsWith("itjs_") ? "sandbox" : "live";
}

export interface TransportOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per request, in milliseconds. Default 30 s. */
  timeoutMs?: number;
  /** Retries after the first attempt, for safe calls. Default 2. */
  maxRetries?: number;
  /** Injected in tests; defaults to a real axios instance. */
  http?: AxiosInstance;
  /** Injected in tests to avoid real waits. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Your own key for this logical call; the SDK makes one when you give none. */
  idempotencyKey?: string;
}

const RETRYABLE_CONFLICT = "IDEMPOTENCY_KEY_IN_PROGRESS";
const MAX_WAIT_MS = 30_000;

export class Transport {
  readonly mode: KeyMode;
  private readonly http: AxiosInstance;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TransportOptions) {
    if (!options.apiKey) {
      throw new ItajaConfigError({
        message: "No Itaja API key. Set ITAJA_API_KEY, or pass apiKey.",
        code: "API_KEY_MISSING",
        status: 0,
      });
    }
    this.mode = modeOfKey(options.apiKey);
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.http =
      options.http ??
      axios.create({
        baseURL: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
        timeout: options.timeoutMs ?? 30_000,
        headers: {
          "x-itj-key": options.apiKey,
          "x-itaja-client": `itaja-node/${SDK_VERSION}`,
          accept: "application/json",
        },
        // Every status is read here: the envelope decides, not axios.
        validateStatus: () => true,
      });
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const isWrite = options.method !== "GET";
    const idempotencyKey = isWrite ? (options.idempotencyKey ?? randomUUID()) : undefined;
    const query = options.query
      ? Object.fromEntries(Object.entries(options.query).filter(([, v]) => v !== undefined && v !== null))
      : undefined;

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.http.request({
          method: options.method,
          url: options.path,
          params: query,
          data: options.body,
          headers: {
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new ItajaConnectionError({
          message: `Could not reach Itaja: ${isAxiosError(error) ? (error.code ?? error.message) : String(error)}`,
          code: "CONNECTION_ERROR",
          status: 0,
        });
      }

      const payload = (typeof response.data === "object" && response.data !== null ? response.data : {}) as {
        success?: boolean;
        data?: unknown;
        error?: string;
        code?: string;
        details?: Record<string, unknown>;
      };
      const status = response.status;

      if (status < 300 && payload.success !== false) {
        return ("data" in payload ? payload.data : payload) as T;
      }

      const retryAfterSeconds = parseRetryAfter(response.headers?.["retry-after"]);
      const retryable =
        status >= 500 || status === 429 || (status === 409 && payload.code === RETRYABLE_CONFLICT);
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(
          retryAfterSeconds !== null ? Math.min(retryAfterSeconds * 1000, MAX_WAIT_MS) : backoff(attempt),
        );
        continue;
      }

      throw errorForStatus(status, {
        message: payload.error ?? `Itaja answered HTTP ${status}`,
        code: payload.code ?? `HTTP_${status}`,
        requestId: headerString(response.headers?.["x-request-id"]),
        details: payload.details ?? null,
        retryAfterSeconds,
      });
    }
  }
}

function backoff(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return Math.min(base + Math.floor(Math.random() * 250), MAX_WAIT_MS);
}

function parseRetryAfter(value: unknown): number | null {
  const text = headerString(value);
  if (text === null) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function headerString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export { ItajaError };
