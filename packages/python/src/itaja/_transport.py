"""The HTTP layer: the ``{success, data}`` envelope unwrapped, typed errors, and
retries that can never charge twice.

Retry rule: only a call that is safe to send again is retried. The SDK puts an
``Idempotency-Key`` on EVERY write (one per logical call, reused on each retry),
so the API answers a retry with the first response instead of running it again.
Retried: no response, ``5xx``, ``429`` and ``409 IDEMPOTENCY_KEY_IN_PROGRESS``.
``Retry-After`` is honoured, with a ceiling.
"""

from __future__ import annotations

import email.utils
import random
import time
import uuid
from collections.abc import Callable, Mapping
from typing import Any, Literal

import httpx

from ._version import SDK_VERSION
from .errors import ItajaConfigError, ItajaConnectionError, error_for_status

DEFAULT_BASE_URL = "https://api.getitaja.com/api/v1"
Method = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
_RETRYABLE_CONFLICT = "IDEMPOTENCY_KEY_IN_PROGRESS"
_MAX_WAIT = 30.0


def mode_of_key(api_key: str | None) -> Literal["sandbox", "live"]:
    """The collection mode a key acts in: the prefix decides, never an option."""
    return "sandbox" if (api_key or "").startswith("itjs_") else "live"


class Transport:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 2,
        http: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self._sleep = sleep
        self._owns_http = http is None
        self._http = http or httpx.Client(timeout=timeout)

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    @property
    def mode(self) -> Literal["sandbox", "live"]:
        return mode_of_key(self.api_key)

    def request(
        self,
        method: Method,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        idempotency_key: str | None = None,
    ) -> Any:
        if not self.api_key:
            raise ItajaConfigError("No Itaja API key. Set ITAJA_API_KEY, or pass api_key.", code="API_KEY_MISSING")
        is_write = method != "GET"
        key = (idempotency_key or str(uuid.uuid4())) if is_write else None
        params = {k: v for k, v in (query or {}).items() if v is not None}
        headers = {
            "x-itj-key": self.api_key,
            "x-itaja-client": f"itaja-python/{SDK_VERSION}",
            "accept": "application/json",
        }
        if key is not None:
            headers["Idempotency-Key"] = key
        url = f"{self.base_url}/{path.lstrip('/')}"

        attempt = 0
        while True:
            try:
                response = self._http.request(method, url, params=params or None, json=body, headers=headers)
            except httpx.TransportError as error:
                if attempt < self.max_retries:
                    self._sleep(_backoff(attempt))
                    attempt += 1
                    continue
                raise ItajaConnectionError(
                    f"Could not reach Itaja: {type(error).__name__}", code="CONNECTION_ERROR"
                ) from None

            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            status = response.status_code

            if status < 300 and payload.get("success", True) is not False:
                return payload.get("data", payload)

            retry_after = _retry_after(response.headers.get("retry-after"))
            retryable = status >= 500 or status == 429 or (status == 409 and payload.get("code") == _RETRYABLE_CONFLICT)
            if retryable and attempt < self.max_retries:
                self._sleep(min(retry_after, _MAX_WAIT) if retry_after is not None else _backoff(attempt))
                attempt += 1
                continue

            details = payload.get("details")
            message = payload.get("error")
            code = payload.get("code")
            raise error_for_status(
                status,
                message=message if isinstance(message, str) else f"Itaja answered HTTP {status}",
                code=code if isinstance(code, str) else f"HTTP_{status}",
                request_id=response.headers.get("x-request-id"),
                details=details if isinstance(details, dict) else None,
                retry_after_seconds=int(retry_after) if retry_after is not None else None,
            )


def _backoff(attempt: int) -> float:
    return float(min(0.5 * (2**attempt) + random.uniform(0, 0.25), _MAX_WAIT))


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
        return seconds if seconds >= 0 else None
    except ValueError:
        pass
    parsed = email.utils.parsedate_to_datetime(value) if value else None
    if parsed is None:
        return None
    return max(0.0, parsed.timestamp() - time.time())
