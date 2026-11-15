"""Verify Itaja's webhook deliveries.

Itaja signs with Standard Webhooks (https://www.standardwebhooks.com), and with
nothing else::

    webhook-id:        <message id, the same on every retry of the event>
    webhook-timestamp: <unix seconds>
    webhook-signature: v1,<base64>[ v1,<base64>]

    signature = base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>"))

The key is the secret without its ``whsec_`` prefix, base64-decoded. A legacy
``whsec_<48 hex>`` secret needs no rotation: hex is valid base64, so it decodes to
36 bytes like in any ``standardwebhooks`` library. A secret that is not canonical
base64 is used as its UTF-8 bytes, which is what the emitter does.

Several space-separated entries arrive while a secret is rotated: one match is
enough, and an entry of another version than ``v1`` is skipped. The check runs on
the **raw** body, in constant time, and refuses a timestamp more than ``tolerance``
seconds from now, in either direction.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .errors import ItajaSignatureError

ID_HEADER = "webhook-id"
TIMESTAMP_HEADER = "webhook-timestamp"
SIGNATURE_HEADER = "webhook-signature"
SIGNATURE_VERSION = "v1"
SECRET_PREFIX = "whsec_"
DEFAULT_TOLERANCE = 300

_UNIX_SECONDS = re.compile(r"[0-9]+")
_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")

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
    """Checks a delivery and returns its event.

    ``headers`` is the request's header mapping (any casing): ``webhook-id``,
    ``webhook-timestamp`` and ``webhook-signature`` are read from it.

    Raises :class:`ItajaSignatureError`, whose ``code`` says why:

    ================================  ==========================================================
    ``WEBHOOK_SECRET_MISSING``        no secret was given
    ``SIGNATURE_MISSING``             ``webhook-id``, ``webhook-timestamp`` or ``webhook-signature`` is absent
    ``TIMESTAMP_INVALID``             ``webhook-timestamp`` is not unix seconds
    ``TIMESTAMP_OUT_OF_TOLERANCE``    the delivery is older or newer than the tolerance
    ``SIGNATURE_SCHEME_UNSUPPORTED``  ``webhook-signature`` has no ``v1,<base64>`` entry
    ``SIGNATURE_MISMATCH``            no signature was made with this secret
    ``PAYLOAD_INVALID``               signed, but the body is not an Itaja event
    ================================  ==========================================================
    """
    body = payload if isinstance(payload, bytes) else payload.encode("utf-8")
    message_id = _header(headers, ID_HEADER)
    timestamp = _header(headers, TIMESTAMP_HEADER)
    signature = _header(headers, SIGNATURE_HEADER)

    if not secret:
        raise _fail("No webhook secret. Set ITAJA_WEBHOOK_SECRET, or pass webhook_secret.", "WEBHOOK_SECRET_MISSING")
    if message_id is None or timestamp is None or signature is None:
        raise _fail("Missing webhook-id, webhook-timestamp or webhook-signature header.", "SIGNATURE_MISSING")
    if _UNIX_SECONDS.fullmatch(timestamp) is None:
        raise _fail("webhook-timestamp is not a unix time.", "TIMESTAMP_INVALID")
    current = int(time.time()) if now is None else now
    if abs(current - int(timestamp)) > tolerance:
        raise _fail(f"Webhook timestamp is more than {tolerance}s away from now.", "TIMESTAMP_OUT_OF_TOLERANCE")

    candidates = _v1_signatures(signature)
    if not candidates:
        raise _fail("webhook-signature carries no v1,<base64> entry.", "SIGNATURE_SCHEME_UNSUPPORTED")

    expected = _digest(secret, message_id, timestamp, body)
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


def sign_payload(
    payload: bytes | str,
    secret: str,
    *,
    id: str | None = None,
    timestamp: int | None = None,
) -> dict[str, str]:
    """Signs a payload the way Itaja does, for your tests and ``itaja trigger``.

    Returns the three headers to send: ``webhook-id``, ``webhook-timestamp`` and
    ``webhook-signature``. ``id`` defaults to a fresh ``msg_<uuid>``; a retry of the
    same event must reuse it.
    """
    message_id = id if id is not None else f"msg_{uuid.uuid4()}"
    ts = str(int(time.time()) if timestamp is None else timestamp)
    body = payload if isinstance(payload, bytes) else payload.encode("utf-8")
    digest = base64.b64encode(_digest(secret, message_id, ts, body)).decode()
    return {ID_HEADER: message_id, TIMESTAMP_HEADER: ts, SIGNATURE_HEADER: f"{SIGNATURE_VERSION},{digest}"}


def _secret_key(secret: str) -> bytes:
    """The HMAC key: what follows ``whsec_``, base64-decoded. Text that is not canonical
    base64 (it would not encode back to itself) is used as its UTF-8 bytes, like the emitter."""
    text = secret[len(SECRET_PREFIX) :] if secret.startswith(SECRET_PREFIX) else secret
    if _BASE64.fullmatch(text) is not None and len(text) % 4 == 0:
        try:
            decoded = base64.b64decode(text, validate=True)
        except (binascii.Error, ValueError):
            decoded = b""
        if decoded and base64.b64encode(decoded).decode() == text:
            return decoded
    return text.encode("utf-8")


def _digest(secret: str, message_id: str, timestamp: str, body: bytes) -> bytes:
    """HMAC-SHA256 over ``<id>.<timestamp>.<raw body>``: the body bytes go in untouched."""
    content = f"{message_id}.{timestamp}.".encode() + body
    return hmac.new(_secret_key(secret), content, hashlib.sha256).digest()


def _v1_signatures(header: str) -> list[str]:
    """The base64 part of every ``v1,<base64>`` entry of a space-separated header."""
    signatures = []
    for entry in header.split():
        version, _, rest = entry.partition(",")
        signature = rest.split(",")[0]
        if version == SIGNATURE_VERSION and signature:
            signatures.append(signature)
    return signatures


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
