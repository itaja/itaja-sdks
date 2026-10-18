"""The webhook route in Django, FastAPI, Starlette and Flask, through each framework's
own test client (real request objects, real middleware).

HOW IT CAN FAIL (written before the code)

R1. The route is not mounted, or Django's CSRF protection rejects Itaja's POST.
R2. A bad signature reaches a handler, or answers something else than 400.
R3. The same event id delivered twice runs the handler twice.
R4. A handler that raises is acknowledged (200) or marked processed: Itaja never
    redelivers. After the failure, the redelivery must run it again.
R5. A sandbox event reaches a live key's handlers (or the reverse).
R6. An event type this version does not know raises instead of reaching ``"*"``.
R7. The framework parsed or re-encoded the body before the check, so a valid
    signature on pretty-printed or non-ASCII JSON fails.
R8. An ``async def`` handler is never awaited (it "succeeds" without running), in a
    sync framework (Django, Flask) or an async one (FastAPI).
R9. A GET reaches the handlers instead of being refused.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from itaja import Event, create_itaja, sign_payload
from itaja.client import Itaja

SECRET = "whsec_test"


def body(
    event_type: str = "checkout.paid", *, id: str = "itaja_evt_1", mode: str | None = "sandbox", **data: Any
) -> str:
    envelope: dict[str, Any] = {
        "id": id,
        "type": event_type,
        "apiVersion": "v1",
        "data": data or {"checkoutId": "chk_1"},
    }
    if mode is not None:
        envelope["mode"] = mode
    return json.dumps(envelope)


# ── one poster per framework: (raw body, headers) → (status, json) ──────────

Poster = Callable[[str, dict[str, str]], tuple[int, dict[str, Any]]]


def django_poster(itaja: Itaja) -> Poster:
    import django
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False,
            SECRET_KEY="test",
            ROOT_URLCONF=__name__,
            ALLOWED_HOSTS=["*"],
            MIDDLEWARE=["django.middleware.csrf.CsrfViewMiddleware"],
        )
        django.setup()
    from django.test import Client
    from django.urls import clear_url_caches, path

    from itaja.integrations.django import webhook_view

    global urlpatterns
    urlpatterns = [path("itaja/webhook", webhook_view(itaja))]
    clear_url_caches()
    client = Client(enforce_csrf_checks=True)

    def post(raw: str, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        response = client.post("/itaja/webhook", data=raw, content_type="application/json", headers=headers)
        return response.status_code, json.loads(response.content or b"{}")

    post.get = lambda: client.get("/itaja/webhook").status_code  # type: ignore[attr-defined]
    return post


def fastapi_poster(itaja: Itaja) -> Poster:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from itaja.integrations.starlette import webhook_router

    app = FastAPI()
    app.include_router(webhook_router(itaja))
    client = TestClient(app)

    def post(raw: str, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        response = client.post(
            "/itaja/webhook", content=raw.encode(), headers={"content-type": "application/json", **headers}
        )
        return response.status_code, response.json()

    post.get = lambda: client.get("/itaja/webhook").status_code  # type: ignore[attr-defined]
    return post


def starlette_poster(itaja: Itaja) -> Poster:
    from starlette.applications import Starlette
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from itaja.integrations.starlette import webhook_endpoint

    client = TestClient(Starlette(routes=[Route("/itaja/webhook", webhook_endpoint(itaja), methods=["POST"])]))

    def post(raw: str, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        response = client.post(
            "/itaja/webhook", content=raw.encode(), headers={"content-type": "application/json", **headers}
        )
        return response.status_code, response.json()

    post.get = lambda: client.get("/itaja/webhook").status_code  # type: ignore[attr-defined]
    return post


def flask_poster(itaja: Itaja) -> Poster:
    from flask import Flask

    from itaja.integrations.flask import webhook_blueprint

    app = Flask(__name__)
    app.register_blueprint(webhook_blueprint(itaja))
    client = app.test_client()

    def post(raw: str, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        response = client.post(
            "/itaja/webhook", data=raw.encode(), headers={"content-type": "application/json", **headers}
        )
        return response.status_code, response.get_json()

    post.get = lambda: client.get("/itaja/webhook").status_code  # type: ignore[attr-defined]
    return post


urlpatterns: list[Any] = []
FRAMEWORKS = {"django": django_poster, "fastapi": fastapi_poster, "starlette": starlette_poster, "flask": flask_poster}


@pytest.fixture(params=list(FRAMEWORKS))
def mount(request: pytest.FixtureRequest) -> Iterator[Callable[..., tuple[Itaja, Poster, list[Event]]]]:
    def build(**on: Callable[[Event], Any]) -> tuple[Itaja, Poster, list[Event]]:
        seen: list[Event] = []
        handlers = on or {"checkout.paid": seen.append}
        itaja = create_itaja(api_key="itjs_test", webhook_secret=SECRET, on=handlers)
        return itaja, FRAMEWORKS[request.param](itaja), seen

    yield build


def signed(raw: str, secret: str = SECRET) -> dict[str, str]:
    return sign_payload(raw, secret)


def test_r1_a_signed_delivery_reaches_its_handler(mount: Any) -> None:
    _, post, seen = mount()
    status, answer = post(body(), signed(body()))
    assert (status, answer) == (200, {"received": True, "outcome": "handled"})
    assert [e.data["checkoutId"] for e in seen] == ["chk_1"]


def test_r2_a_bad_signature_answers_400_and_reaches_no_handler(mount: Any) -> None:
    _, post, seen = mount()
    status, answer = post(body(), signed(body(), "whsec_wrong"))
    assert (status, answer["outcome"]) == (400, "invalid_signature")
    assert seen == []


def test_r3_the_same_event_id_runs_the_handler_once(mount: Any) -> None:
    _, post, seen = mount()
    assert post(body(), signed(body()))[1]["outcome"] == "handled"
    assert post(body(), signed(body()))[1]["outcome"] == "duplicate"
    assert len(seen) == 1


def test_r4_a_raising_handler_answers_500_and_the_redelivery_runs_it_again(mount: Any) -> None:
    attempts: list[int] = []

    def flaky(event: Event) -> None:
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("fulfilment failed")

    _, post, _ = mount(**{"checkout.paid": flaky})
    assert post(body(), signed(body())) == (500, {"received": False, "outcome": "handler_failed"})
    assert post(body(), signed(body()))[0] == 200
    assert len(attempts) == 2


def test_r5_an_event_of_the_other_mode_is_acknowledged_and_ignored(mount: Any) -> None:
    _, post, seen = mount()
    live = body(mode="live")
    assert post(live, signed(live)) == (200, {"received": True, "outcome": "ignored_mode"})
    unmarked = body(id="itaja_evt_2", mode=None)
    assert post(unmarked, signed(unmarked))[1]["outcome"] == "handled"
    assert len(seen) == 1


def test_r6_an_unknown_type_reaches_the_catch_all(mount: Any) -> None:
    caught: list[Event] = []
    _, post, _ = mount(**{"*": caught.append})
    raw = body("subscription.activated", planId="pro")
    assert post(raw, signed(raw))[1]["outcome"] == "handled"
    assert [(e.type, e.data["planId"]) for e in caught] == [("subscription.activated", "pro")]


def test_r7_the_signature_is_checked_on_the_exact_raw_bytes(mount: Any) -> None:
    _, post, seen = mount()
    raw = (
        '{\n  "id": "itaja_evt_raw",\n  "type": "checkout.paid",\n  "mode": "sandbox",\n'
        '  "data": {"checkoutId": "Ça coûte 5000 F\\u00e7 \\/ é"}\n}'
    )
    assert post(raw, signed(raw))[1]["outcome"] == "handled"
    assert seen[0].data["checkoutId"] == "Ça coûte 5000 Fç / é"


def test_r8_an_async_handler_is_awaited_in_every_framework(mount: Any) -> None:
    ran: list[str] = []

    async def fulfil(event: Event) -> None:
        ran.append(event.id)

    _, post, _ = mount(**{"checkout.paid": fulfil})
    assert post(body(), signed(body()))[1]["outcome"] == "handled"
    assert ran == ["itaja_evt_1"]


def test_r9_only_post_is_accepted(mount: Any) -> None:
    _, post, seen = mount()
    assert post.get() == 405
    assert seen == []
