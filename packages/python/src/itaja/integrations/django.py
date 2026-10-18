"""Django: ``path("itaja/webhook", webhook_view(itaja))`` in your ``urls.py``.

The view is CSRF-exempt (Itaja signs its requests instead) and only accepts POST.
It reads ``request.body``, the raw bytes, before Django parses anything.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from django.http import HttpRequest, HttpResponse, HttpResponseNotAllowed, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from ..client import Itaja


def webhook_view(itaja: Itaja) -> Callable[..., HttpResponse]:
    def view(request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        result = itaja.webhooks.process(request.body, request.headers)
        return JsonResponse(result.body, status=result.status)

    # Itaja signs its requests: Django's CSRF token does not apply to this view.
    exempt: Callable[..., HttpResponse] = csrf_exempt(view)
    return exempt
