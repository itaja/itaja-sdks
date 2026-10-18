"""FastAPI and Starlette.

FastAPI::

    app.include_router(webhook_router(itaja))          # POST /itaja/webhook

Starlette::

    Route("/itaja/webhook", webhook_endpoint(itaja), methods=["POST"])

Async handlers are awaited; sync ones are called directly. The body is read raw
(``await request.body()``) so the signature is checked on the exact bytes.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse

from ..client import Itaja


def webhook_endpoint(itaja: Itaja) -> Callable[[Request], Coroutine[Any, Any, JSONResponse]]:
    async def endpoint(request: Request) -> JSONResponse:
        result = await itaja.webhooks.process_async(await request.body(), request.headers)
        return JSONResponse(result.body, status_code=result.status)

    return endpoint


def webhook_router(itaja: Itaja, path: str = "/itaja/webhook") -> Any:
    """A FastAPI ``APIRouter`` with the one route. Hidden from the OpenAPI schema."""
    from fastapi import APIRouter

    router = APIRouter()
    router.add_api_route(path, webhook_endpoint(itaja), methods=["POST"], include_in_schema=False)
    return router
