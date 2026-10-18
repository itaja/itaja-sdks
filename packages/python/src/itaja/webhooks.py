"""Verify Itaja's webhook deliveries.

Each delivery is signed::

    x-itaja-timestamp: <unix seconds>
    x-itaja-signature: v1,<base64 HMAC-SHA256(secret, "<timestamp>.<raw body>")>[,<more>]

Several signatures may follow ``v1,`` while a secret is rotated: one match is enough.
The check runs on the **raw** body, in constant time, and refuses a timestamp more
than ``tolerance`` seconds from now.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .errors import ItajaSignatureError

SIGNATURE_HEADER = "x-itaja-signature"
TIMESTAMP_HEADER = "x-itaja-timestamp"
SIGNATURE_VERSION = "v1"
DEFAULT_TOLERANCE = 300

#: Every topic Itaja emits today.
EVENT_TYPES: tuple[str, ...] = (
    "checkout.paid",
    "credits.granted",
    "credits.consumed",
    "credits.expired",
    "credits.low",
    "credits.clawed_back",
    "license.issued",
    "license.activated",
    "license.deactivated",
    "license.revoked",
    "license.expired",
    "license.rotated",
    "license.suspended",
    "license.resumed",
    "license.updated",
    "invoice.paid",
    "invoice.payment_failed",
    "subscription.past_due",
    "subscription.canceled",
)


@dataclass(frozen=True)
class Event:
    """A verified delivery."""

    #: ``itaja_evt_...``: the identity a retried delivery keeps.
    id: str
    #: ``checkout.paid``, ``credits.low``, ...
    type: str
    #: The topic's documented payload.
    data: dict[str, Any]
    mode: str | None = None
    api_version: str | None = None
    created_at: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


Headers = Mapping[str, Any]


def construct_event(
    payload: bytes | str,
    headers: Headers,
    secret: str,
    *,
    tolerance: int = DEFAULT_TOLERANCE,
    now: int | None = None,
) -> Event:
    """Checks a delivery and returns its event. Raises :class:`ItajaSignatureError` when the
    signature is missing, wrong, or older than the tolerance."""
    body = payload.decode("utf-8") if isinstance(payload, bytes) else payload
    signature = _header(headers, SIGNATURE_HEADER)
    timestamp = _header(headers, TIMESTAMP_HEADER)

    if not secret:
        raise _fail("No webhook secret. Set ITAJA_WEBHOOK_SECRET, or pass webhook_secret.", "WEBHOOK_SECRET_MISSING")
    if signature is None or timestamp is None:
        raise _fail("Missing x-itaja-signature or x-itaja-timestamp header.", "SIGNATURE_MISSING")
    if not timestamp.isdigit():
        raise _fail("x-itaja-timestamp is not a unix time.", "TIMESTAMP_INVALID")
    current = int(time.time()) if now is None else now
    if abs(current - int(timestamp)) > tolerance:
        raise _fail(f"Webhook timestamp is more than {tolerance}s away from now.", "TIMESTAMP_OUT_OF_TOLERANCE")

    version, *candidates = [part.strip() for part in signature.split(",")]
    if version != SIGNATURE_VERSION or not candidates:
        raise _fail("Unsupported signature scheme.", "SIGNATURE_SCHEME_UNSUPPORTED")

    expected = hmac.new(secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).digest()
    matched = False
    for candidate in candidates:
        try:
            given = base64.b64decode(candidate, validate=True)
        except (binascii.Error, ValueError):
            continue
        # No early exit: every candidate is compared, in constant time.
        if hmac.compare_digest(expected, given):
            matched = True
    if not matched:
        raise _fail("Webhook signature does not match.", "SIGNATURE_MISMATCH")

    try:
        envelope = json.loads(body)
    except ValueError as error:
        raise _fail("Webhook body is not JSON.", "PAYLOAD_INVALID") from error
    if (
        not isinstance(envelope, dict)
        or not isinstance(envelope.get("id"), str)
        or not isinstance(envelope.get("type"), str)
        or not isinstance(envelope.get("data"), dict)
    ):
        raise _fail("Webhook body is not an Itaja event.", "PAYLOAD_INVALID")
    return Event(
        id=envelope["id"],
        type=envelope["type"],
        data=envelope["data"],
        mode=envelope.get("mode"),
        api_version=envelope.get("apiVersion"),
        created_at=envelope.get("createdAt"),
        raw=envelope,
    )


def sign_payload(payload: str, secret: str, *, timestamp: int | None = None) -> dict[str, str]:
    """Signs a payload the way Itaja does, for your tests and ``itaja trigger``. Returns the two headers."""
    ts = str(int(time.time()) if timestamp is None else timestamp)
    digest = hmac.new(secret.encode(), f"{ts}.{payload}".encode(), hashlib.sha256).digest()
    return {SIGNATURE_HEADER: f"{SIGNATURE_VERSION},{base64.b64encode(digest).decode()}", TIMESTAMP_HEADER: ts}


def _header(headers: Headers, name: str) -> str | None:
    getter = getattr(headers, "get", None)
    # Starlette, Flask/Werkzeug, httpx and Django's HttpHeaders are case-insensitive mappings.
    value = getter(name) if callable(getter) else None
    if value is None:
        for key in headers:
            if isinstance(key, str) and key.lower() == name:
                value = headers[key]
                break
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if isinstance(value, bytes):
        value = value.decode("latin-1")
    return value if isinstance(value, str) and value != "" else None


def _fail(message: str, code: str) -> ItajaSignatureError:
    return ItajaSignatureError(message, code=code, status=400)
