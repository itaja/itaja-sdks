export { createItaja } from "./client.js";
export type { Itaja, ItajaOptions, ProductRef, PushResult, WriteOptions } from "./client.js";

export { feature, group, plan, credits, creditPack, license, toCatalogDocument, normalizeName, NAME_MAX_LENGTH } from "./catalog.js";
export type {
  BooleanFeature,
  CatalogDocument,
  CatalogItem,
  CreditPack,
  Credits,
  CreditsNameOf,
  Feature,
  FeatureInclusion,
  Group,
  Interval,
  License,
  LicenseDuration,
  GroupNameOf,
  LicenseNameOf,
  MeteredFeature,
  Money,
  Plan,
  PlanNameOf,
  ProductNameOf,
  Reset,
} from "./catalog.js";

export {
  constructEvent,
  signPayload,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  DEFAULT_TOLERANCE_SECONDS,
} from "./webhooks.js";
export type { AnyItajaEvent, EventDataMap, EventType, ItajaEvent, VerifyInput } from "./webhooks.js";

export { createWebhookHandler, memoryDedupeStore, processWebhook, toNodeHandler } from "./handler.js";
export type { DedupeStore, EventHandler, EventHandlers, WebhookHandlerOptions, WebhookOutcome, WebhookResult } from "./handler.js";

export {
  ItajaError,
  ItajaAuthenticationError,
  ItajaConfigError,
  ItajaConflictError,
  ItajaConnectionError,
  ItajaNotFoundError,
  ItajaPermissionError,
  ItajaRateLimitError,
  ItajaServerError,
  ItajaSignatureError,
  ItajaValidationError,
} from "./errors.js";

export { modeOfKey, DEFAULT_BASE_URL } from "./transport.js";
export type { KeyMode } from "./transport.js";
export { SDK_VERSION } from "./version.js";
