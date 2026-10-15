/**
 * One error hierarchy for everything the SDK can fail on (ADR 0015 D8).
 *
 * `code` is the API's stable code (ADR 0005) — branch on it, never on
 * `message`. No error ever carries the API key or the webhook secret: the
 * transport builds these from the response body only, never from the request.
 */
export class ItajaError extends Error {
  /** Stable machine code from the API (`CUSTOMER_NOT_FOUND`, …), or an SDK code. */
  readonly code: string;
  /** HTTP status, `0` when no response arrived. */
  readonly status: number;
  /** The API's request id when it sent one, for support. */
  readonly requestId: string | null;
  /** Structured details from the API (`details.issues[]` on `CATALOG_INVALID`, …). */
  readonly details: Record<string, unknown> | null;

  constructor(input: {
    message: string;
    code: string;
    status: number;
    requestId?: string | null;
    details?: Record<string, unknown> | null;
  }) {
    super(input.message);
    this.name = new.target.name;
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId ?? null;
    this.details = input.details ?? null;
  }
}

/** `400` / `422`: the request is malformed or breaks a rule. */
export class ItajaValidationError extends ItajaError {}
/** `401`: the API key is missing, unknown, disabled or expired. */
export class ItajaAuthenticationError extends ItajaError {}
/** `403`: the key may not do this (product scope, live gate). */
export class ItajaPermissionError extends ItajaError {}
/** `404`: absent, or not yours — the API answers both the same. */
export class ItajaNotFoundError extends ItajaError {}
/** `409`: the resource's state forbids it (mode mismatch, transition, idempotency key in use). */
export class ItajaConflictError extends ItajaError {}
/** `429`: slow down; `retryAfterSeconds` says for how long when the API said it. */
export class ItajaRateLimitError extends ItajaError {
  readonly retryAfterSeconds: number | null;
  constructor(input: ConstructorParameters<typeof ItajaError>[0] & { retryAfterSeconds: number | null }) {
    super(input);
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}
/** `5xx`: Itaja or a provider behind it failed. Safe calls were already retried. */
export class ItajaServerError extends ItajaError {}
/** No response: network down, DNS, timeout. Safe calls were already retried. */
export class ItajaConnectionError extends ItajaError {}
/** A webhook whose signature, timestamp or body does not check out. */
export class ItajaSignatureError extends ItajaError {}
/** The SDK is misconfigured (no API key, an invalid catalogue declaration, …). */
export class ItajaConfigError extends ItajaError {}

export function errorForStatus(
  status: number,
  input: { message: string; code: string; requestId: string | null; details: Record<string, unknown> | null; retryAfterSeconds: number | null },
): ItajaError {
  const base = { ...input, status };
  if (status === 400 || status === 422) return new ItajaValidationError(base);
  if (status === 401) return new ItajaAuthenticationError(base);
  if (status === 403) return new ItajaPermissionError(base);
  if (status === 404) return new ItajaNotFoundError(base);
  if (status === 409) return new ItajaConflictError(base);
  if (status === 429) return new ItajaRateLimitError(base);
  if (status >= 500) return new ItajaServerError(base);
  return new ItajaError(base);
}
