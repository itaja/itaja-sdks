"""Itaja for Python servers: declare what you sell, push it, mount one webhook route, react to events."""

from ._transport import DEFAULT_BASE_URL, mode_of_key
from ._version import SDK_VERSION
from .catalog import (
    CreditPack,
    Credits,
    Feature,
    Group,
    License,
    Plan,
    credit_pack,
    credits,
    feature,
    group,
    license,
    normalize_name,
    plan,
    to_catalog_document,
)
from .client import Itaja, create_itaja
from .errors import (
    ItajaAuthenticationError,
    ItajaConfigError,
    ItajaConflictError,
    ItajaConnectionError,
    ItajaError,
    ItajaNotFoundError,
    ItajaPermissionError,
    ItajaRateLimitError,
    ItajaServerError,
    ItajaSignatureError,
    ItajaValidationError,
)
from .handler import DedupeStore, MemoryDedupeStore, WebhookProcessor, WebhookResult
from .webhooks import EVENT_TYPES, Event, construct_event, sign_payload

__version__ = SDK_VERSION

__all__ = [
    "DEFAULT_BASE_URL",
    "EVENT_TYPES",
    "SDK_VERSION",
    "CreditPack",
    "Credits",
    "DedupeStore",
    "Event",
    "Feature",
    "Group",
    "Itaja",
    "ItajaAuthenticationError",
    "ItajaConfigError",
    "ItajaConflictError",
    "ItajaConnectionError",
    "ItajaError",
    "ItajaNotFoundError",
    "ItajaPermissionError",
    "ItajaRateLimitError",
    "ItajaServerError",
    "ItajaSignatureError",
    "ItajaValidationError",
    "License",
    "MemoryDedupeStore",
    "Plan",
    "WebhookProcessor",
    "WebhookResult",
    "construct_event",
    "create_itaja",
    "credit_pack",
    "credits",
    "feature",
    "group",
    "license",
    "mode_of_key",
    "normalize_name",
    "plan",
    "sign_payload",
    "to_catalog_document",
]
