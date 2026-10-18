"""The framework-free core of the webhook route.

It verifies the signature on the raw body, ignores an event of the other mode,
drops a delivery it already processed, calls your handlers, and answers ``500``
when one raises, so Itaja delivers again. The Django, FastAPI/Starlette and Flask
adapters in :mod:`itaja.integrations` only turn their request into ``(body, headers)``.
"""

from __future__ import annotations

import inspect
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .errors import ItajaConfigError, ItajaSignatureError
from .webhooks import DEFAULT_TOLERANCE, Event, construct_event

Handler = Callable[[Event], Any]
"""A webhook handler: ``def f(event)`` or ``async def f(event)``."""
Outcome = Literal["handled", "duplicate", "ignored_mode", "unhandled", "invalid_signature", "handler_failed"]


class DedupeStore(Protocol):
    """Where processed event ids are kept so a redelivery is not handled twice. Behind several
    instances, give a shared store (Redis, your database) with the same two methods."""

    def has(self, event_id: str) -> bool: ...

    def add(self, event_id: str) -> None: ...


class MemoryDedupeStore:
    """In memory, bounded (oldest dropped first), entries kept 24 h. Enough for one process."""

    def __init__(self, *, max_size: int = 10_000, ttl_seconds: float = 86_400) -> None:
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._max = max_size
        self._ttl = ttl_seconds
        self._lock = threading.Lock()

    def has(self, event_id: str) -> bool:
        with self._lock:
            at = self._seen.get(event_id)
            if at is None:
                return False
            if time.monotonic() - at > self._ttl:
                del self._seen[event_id]
                return False
            return True

    def add(self, event_id: str) -> None:
        with self._lock:
            self._seen.pop(event_id, None)
            self._seen[event_id] = time.monotonic()
            while len(self._seen) > self._max:
                self._seen.popitem(last=False)


@dataclass(frozen=True)
class WebhookResult:
    status: int
    outcome: Outcome
    event_id: str | None

    @property
    def body(self) -> dict[str, Any]:
        return {"received": self.status == 200, "outcome": self.outcome}


class WebhookProcessor:
    def __init__(
        self,
        *,
        secret: str,
        mode: str,
        handlers: Mapping[str, Handler],
        dedupe: DedupeStore | None = None,
        tolerance: int = DEFAULT_TOLERANCE,
        on_error: Callable[[BaseException, Event], None] | None = None,
    ) -> None:
        self.secret = secret
        self.mode = mode
        self.handlers = dict(handlers)
        self.dedupe: DedupeStore = dedupe if dedupe is not None else MemoryDedupeStore()
        self.tolerance = tolerance
        self.on_error = on_error

    def _verify(self, body: bytes | str, headers: Mapping[str, Any]) -> Event | WebhookResult:
        if not self.secret:
            raise ItajaConfigError(
                "No webhook secret. Set ITAJA_WEBHOOK_SECRET, or pass webhook_secret.", code="WEBHOOK_SECRET_MISSING"
            )
        try:
            event = construct_event(body, headers, self.secret, tolerance=self.tolerance)
        except ItajaSignatureError:
            return WebhookResult(400, "invalid_signature", None)
        if event.mode is not None and event.mode != self.mode:
            return WebhookResult(200, "ignored_mode", event.id)
        if self.dedupe.has(event.id):
            return WebhookResult(200, "duplicate", event.id)
        return event

    def _targets(self, event: Event) -> list[Handler]:
        return [h for h in (self.handlers.get(event.type), self.handlers.get("*")) if h is not None]

    def process(self, body: bytes | str, headers: Mapping[str, Any]) -> WebhookResult:
        """For sync frameworks (Django, Flask). An ``async def`` handler is run to completion."""
        verified = self._verify(body, headers)
        if isinstance(verified, WebhookResult):
            return verified
        targets = self._targets(verified)
        if not targets:
            self.dedupe.add(verified.id)
            return WebhookResult(200, "unhandled", verified.id)
        try:
            for handler in targets:
                result = handler(verified)
                if inspect.isawaitable(result):
                    _run_sync(result)
        except Exception as error:
            # Not marked processed: Itaja's redelivery runs the handlers again.
            if self.on_error is not None:
                self.on_error(error, verified)
            return WebhookResult(500, "handler_failed", verified.id)
        self.dedupe.add(verified.id)
        return WebhookResult(200, "handled", verified.id)

    async def process_async(self, body: bytes | str, headers: Mapping[str, Any]) -> WebhookResult:
        """For async frameworks (FastAPI, Starlette). Sync handlers are called directly."""
        verified = self._verify(body, headers)
        if isinstance(verified, WebhookResult):
            return verified
        targets = self._targets(verified)
        if not targets:
            self.dedupe.add(verified.id)
            return WebhookResult(200, "unhandled", verified.id)
        try:
            for handler in targets:
                result = handler(verified)
                if inspect.isawaitable(result):
                    await result
        except Exception as error:
            if self.on_error is not None:
                self.on_error(error, verified)
            return WebhookResult(500, "handler_failed", verified.id)
        self.dedupe.add(verified.id)
        return WebhookResult(200, "handled", verified.id)


def _run_sync(awaitable: Awaitable[Any]) -> Any:
    import asyncio

    async def wrap() -> Any:
        return await awaitable

    return asyncio.run(wrap())
