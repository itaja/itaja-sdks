"""One hierarchy for everything the SDK can fail on.

Branch on ``code`` (the API's stable code), never on the message. No error ever
carries the API key or the webhook secret: the transport builds them from the
response body only, never from the request.
"""

from __future__ import annotations

from typing import Any


class ItajaError(Exception):
    """Base of every SDK error."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: int = 0,
        request_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        #: Stable machine code from the API (``CUSTOMER_NOT_FOUND``), or an SDK code.
        self.code = code
        #: HTTP status, ``0`` when no response arrived.
        self.status = status
        #: The API's request id when it sent one, for support.
        self.request_id = request_id
        #: Structured details from the API (``details["issues"]`` on ``CATALOG_INVALID``).
        self.details = details

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, status={self.status}, message={self.message!r})"


class ItajaValidationError(ItajaError):
    """``400`` / ``422``: the request is malformed or breaks a rule."""


class ItajaAuthenticationError(ItajaError):
    """``401``: the API key is missing, unknown, disabled or expired."""


class ItajaPermissionError(ItajaError):
    """``403``: the key may not do this (product scope, live gate)."""


class ItajaNotFoundError(ItajaError):
    """``404``: absent, or not yours; the API answers both the same."""


class ItajaConflictError(ItajaError):
    """``409``: the resource's state forbids it (mode mismatch, transition, idempotency key in use)."""


class ItajaRateLimitError(ItajaError):
    """``429``: slow down; ``retry_after_seconds`` says for how long when the API said it."""

    def __init__(self, message: str, *, retry_after_seconds: int | None = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.retry_after_seconds = retry_after_seconds


class ItajaServerError(ItajaError):
    """``5xx``: Itaja or a provider behind it failed. Safe calls were already retried."""


class ItajaConnectionError(ItajaError):
    """No response: network down, DNS, timeout. Safe calls were already retried."""


class ItajaSignatureError(ItajaError):
    """A webhook whose signature, timestamp or body does not check out."""


class ItajaConfigError(ItajaError):
    """The SDK is misconfigured (no API key, an invalid catalogue declaration, ...)."""


def error_for_status(
    status: int,
    *,
    message: str,
    code: str,
    request_id: str | None,
    details: dict[str, Any] | None,
    retry_after_seconds: int | None,
) -> ItajaError:
    common: dict[str, Any] = {"code": code, "status": status, "request_id": request_id, "details": details}
    if status in (400, 422):
        return ItajaValidationError(message, **common)
    if status == 401:
        return ItajaAuthenticationError(message, **common)
    if status == 403:
        return ItajaPermissionError(message, **common)
    if status == 404:
        return ItajaNotFoundError(message, **common)
    if status == 409:
        return ItajaConflictError(message, **common)
    if status == 429:
        return ItajaRateLimitError(message, retry_after_seconds=retry_after_seconds, **common)
    if status >= 500:
        return ItajaServerError(message, **common)
    return ItajaError(message, **common)
