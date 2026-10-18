"""The HTTP layer and ``create_itaja``'s configuration, against httpx's MockTransport.

HOW IT CAN FAIL (written before the code)

T1. The ``{success, data}`` envelope is not unwrapped, or a ``success: false`` 200 is
    returned as data.
T2. A write is sent without an ``Idempotency-Key``, or each retry uses a new one
    (the retry could run twice: a double charge).
T3. A 4xx is retried, or a 5xx / 429 / network error / ``409
    IDEMPOTENCY_KEY_IN_PROGRESS`` is not.
T4. ``Retry-After`` is ignored, or honoured without a ceiling.
T5. An error loses its code, status, request id or details, or maps to the wrong class.
T6. The API key appears in an error message.
T7. The caller's own idempotency key is replaced by a generated one.
E1. ``api_key`` / ``webhook_secret`` / ``base_url`` passed to ``create_itaja`` are
    ignored when the ``ITAJA_*`` variables are set.
E2. Without arguments, ``ITAJA_API_KEY`` / ``ITAJA_WEBHOOK_SECRET`` /
    ``ITAJA_API_URL`` are not read.
E3. A missing key or secret fails silently instead of naming the variable.
K1. A catalogue id is sent instead of Itaja's product id, or the map is stale after a
    push that re-created the product.
K2. A credit movement sends a body ``idempotencyKey`` different from the header's.
K3. ``subscribe`` / ``check`` / ``report`` pretend to work.
K4. An id with a slash or a space breaks the URL.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from itaja import (
    ItajaAuthenticationError,
    ItajaConfigError,
    ItajaConflictError,
    ItajaConnectionError,
    ItajaError,
    ItajaNotFoundError,
    ItajaPermissionError,
    ItajaRateLimitError,
    ItajaServerError,
    ItajaValidationError,
    create_itaja,
    sign_payload,
)
from itaja.client import Itaja

KEY = "itjs_super_secret_key_do_not_leak"


def ok(data: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json={"success": True, "data": data})


def fail(status: int, code: str, **extra: Any) -> httpx.Response:
    headers = extra.pop("headers", {})
    return httpx.Response(status, json={"success": False, "error": "refused", "code": code, **extra}, headers=headers)


class Recorder:
    def __init__(self, answer: Callable[[httpx.Request], httpx.Response] | list[httpx.Response]) -> None:
        self.requests: list[httpx.Request] = []
        self.slept: list[float] = []
        self._answer = answer

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if callable(self._answer):
            return self._answer(request)
        return self._answer[len(self.requests) - 1]

    def client(self, **kwargs: Any) -> Itaja:
        kwargs.setdefault("api_key", KEY)
        kwargs.setdefault("base_url", "https://api.test/api/v1")
        return create_itaja(http=httpx.Client(transport=httpx.MockTransport(self)), sleep=self.slept.append, **kwargs)


def test_t1_the_envelope_is_unwrapped_and_a_success_false_200_is_an_error() -> None:
    r = Recorder([ok({"id": "cus_1"}), httpx.Response(200, json={"success": False, "error": "odd", "code": "ODD"})])
    assert r.client().customers.get("cus_1") == {"id": "cus_1"}
    with pytest.raises(ItajaError, match="odd"):
        r.client().customers.get("cus_1")


def test_t2_every_write_carries_one_idempotency_key_reused_on_each_retry() -> None:
    r = Recorder([fail(502, "BAD_GATEWAY"), fail(503, "BAD_GATEWAY"), ok({"ok": True}, 201)])
    assert r.client().customers.create(name="A") == {"ok": True}
    keys = {req.headers.get("idempotency-key") for req in r.requests}
    assert len(r.requests) == 3 and len(keys) == 1 and None not in keys


def test_t2_a_read_carries_no_idempotency_key_and_the_key_header_is_sent() -> None:
    r = Recorder([ok([])])
    r.client().customers.list()
    assert "idempotency-key" not in r.requests[0].headers
    assert r.requests[0].headers["x-itj-key"] == KEY


def test_t7_the_callers_own_key_is_the_one_sent() -> None:
    r = Recorder([ok({}, 201)])
    r.client().customers.create(name="A", idempotency_key="order-4217")
    assert r.requests[0].headers["idempotency-key"] == "order-4217"


@pytest.mark.parametrize(
    ("status", "cls"),
    [
        (400, ItajaValidationError),
        (422, ItajaValidationError),
        (401, ItajaAuthenticationError),
        (403, ItajaPermissionError),
        (404, ItajaNotFoundError),
        (409, ItajaConflictError),
    ],
)
def test_t3_t5_a_4xx_is_never_retried_and_maps_to_its_class(status: int, cls: type[ItajaError]) -> None:
    r = Recorder(
        lambda _: fail(
            status, "SOME_CODE", details={"issues": [{"path": "a", "message": "b"}]}, headers={"x-request-id": "req_9"}
        )
    )
    with pytest.raises(cls) as caught:
        r.client().customers.create(name="A")
    assert (caught.value.code, caught.value.status, caught.value.request_id) == ("SOME_CODE", status, "req_9")
    assert caught.value.details == {"issues": [{"path": "a", "message": "b"}]}
    assert len(r.requests) == 1 and r.slept == []


def test_t3_t4_a_429_is_retried_honouring_retry_after_with_a_ceiling() -> None:
    r = Recorder(
        [
            fail(429, "RATE_LIMITED", headers={"Retry-After": "2"}),
            fail(429, "RATE_LIMITED", headers={"Retry-After": "3600"}),
            ok({"ok": 1}),
        ]
    )
    assert r.client().customers.list() == {"ok": 1}
    assert r.slept == [2.0, 30.0]


def test_t3_an_exhausted_429_is_a_rate_limit_error_with_retry_after() -> None:
    r = Recorder(lambda _: fail(429, "RATE_LIMITED", headers={"Retry-After": "7"}))
    with pytest.raises(ItajaRateLimitError) as caught:
        r.client(max_retries=1).customers.list()
    assert caught.value.retry_after_seconds == 7 and len(r.requests) == 2


def test_t3_an_in_progress_idempotency_conflict_is_retried() -> None:
    r = Recorder([fail(409, "IDEMPOTENCY_KEY_IN_PROGRESS"), ok({"done": True}, 201)])
    assert r.client().customers.create(name="A") == {"done": True}


def test_t3_a_5xx_exhausts_its_retries_then_raises_a_server_error() -> None:
    r = Recorder(lambda _: fail(500, "INTERNAL"))
    with pytest.raises(ItajaServerError):
        r.client().customers.list()
    assert len(r.requests) == 3


def test_t3_t6_a_network_error_is_retried_then_a_connection_error_without_the_key() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url} with {request.headers['x-itj-key']}")

    r = Recorder(down)
    with pytest.raises(ItajaConnectionError) as caught:
        r.client().customers.list()
    assert len(r.requests) == 3
    assert KEY not in str(caught.value) and KEY not in repr(caught.value)


def test_t6_no_error_ever_carries_the_api_key() -> None:
    r = Recorder(lambda _: fail(401, "API_KEY_INVALID"))
    with pytest.raises(ItajaAuthenticationError) as caught:
        r.client().customers.list()
    assert KEY not in f"{caught.value} {caught.value!r} {caught.value.details}"


# ── configuration ───────────────────────────────────────────────────────────


def test_e2_reads_the_key_the_secret_and_the_url_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ITAJA_API_KEY", "itjs_from_env")
    monkeypatch.setenv("ITAJA_WEBHOOK_SECRET", "whsec_from_env")
    monkeypatch.setenv("ITAJA_API_URL", "https://staging.test/api/v1/")
    r = Recorder([ok({})])
    itaja = create_itaja(http=httpx.Client(transport=httpx.MockTransport(r)))
    itaja.request("GET", "/me")
    assert itaja.mode == "sandbox"
    assert str(r.requests[0].url) == "https://staging.test/api/v1/me"
    assert r.requests[0].headers["x-itj-key"] == "itjs_from_env"
    raw = json.dumps({"id": "e", "type": "checkout.paid", "mode": "sandbox", "data": {}})
    assert itaja.webhooks.process(raw, sign_payload(raw, "whsec_from_env")).status == 200


def test_e1_explicit_arguments_win_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ITAJA_API_KEY", "itjs_from_env")
    monkeypatch.setenv("ITAJA_WEBHOOK_SECRET", "whsec_from_env")
    monkeypatch.setenv("ITAJA_API_URL", "https://never.test/api/v1")
    r = Recorder([ok({})])
    itaja = create_itaja(
        api_key="itjp_explicit",
        webhook_secret="whsec_explicit",
        base_url="https://api.test/api/v1",
        http=httpx.Client(transport=httpx.MockTransport(r)),
    )
    itaja.request("GET", "/me")
    assert (itaja.mode, str(r.requests[0].url), r.requests[0].headers["x-itj-key"]) == (
        "live",
        "https://api.test/api/v1/me",
        "itjp_explicit",
    )
    raw = json.dumps({"id": "e", "type": "checkout.paid", "mode": "live", "data": {}})
    assert itaja.webhooks.process(raw, sign_payload(raw, "whsec_from_env")).status == 400


def test_e3_a_missing_key_or_secret_names_the_variable() -> None:
    r = Recorder([])
    itaja = create_itaja(http=httpx.Client(transport=httpx.MockTransport(r)))
    with pytest.raises(ItajaConfigError, match="ITAJA_API_KEY"):
        itaja.customers.get("cus_1")
    with pytest.raises(ItajaConfigError, match="ITAJA_WEBHOOK_SECRET"):
        itaja.webhooks.process("{}", {})
    assert r.requests == []
    assert itaja.catalog == {"features": [], "products": []}  # printing the catalogue needs no key


# ── the client ──────────────────────────────────────────────────────────────


def test_k1_a_catalogue_id_resolves_once_and_again_after_a_push() -> None:
    current = {"id": "prd_old"}

    def api(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/catalog"):
            current["id"] = "prd_new"
            return ok({"summary": {"created": 1}, "changes": []})
        if request.url.path.endswith("/products"):
            return ok([{"id": current["id"], "catalogKey": "tokens"}])
        return ok({"balance": 5})

    r = Recorder(api)
    itaja = r.client()
    itaja.credits.balance(customer_id="cus_1", product="tokens")
    itaja.credits.balance(customer_id="cus_1", product="tokens")
    itaja.push()
    itaja.credits.balance(customer_id="cus_1", product="tokens")
    balances = [req.url.path for req in r.requests if req.url.path.endswith("/balance")]
    lookups = [req for req in r.requests if req.url.path.endswith("/products")]
    assert balances == [
        "/api/v1/products/prd_old/credits/cus_1/balance",
        "/api/v1/products/prd_old/credits/cus_1/balance",
        "/api/v1/products/prd_new/credits/cus_1/balance",
    ]
    assert len(lookups) == 2


def test_k1_a_product_never_pushed_says_to_push_and_a_dashboard_id_needs_no_lookup() -> None:
    r = Recorder(lambda request: ok([]) if request.url.path.endswith("/products") else ok({"balance": 1}))
    with pytest.raises(ItajaNotFoundError, match="itaja push") as caught:
        r.client().licenses.issue(product="desktop")
    assert caught.value.code == "CATALOG_PRODUCT_NOT_PUSHED"
    r.requests.clear()
    r.client().credits.balance(customer_id="cus_1", product_id="prd_dash")
    assert [req.url.path for req in r.requests] == ["/api/v1/products/prd_dash/credits/cus_1/balance"]


def test_k2_a_credit_movement_sends_the_same_key_in_header_and_body() -> None:
    r = Recorder(
        lambda request: (
            ok([{"id": "prd_77", "catalogKey": "tokens"}]) if request.url.path.endswith("/products") else ok({}, 201)
        )
    )
    itaja = r.client()
    itaja.credits.consume(customer_id="cus_1", amount=3, product="tokens")
    itaja.credits.grant(customer_id="cus_1", amount=50, product="tokens", idempotency_key="order-9")
    consume, grant = (req for req in r.requests if "/credits/" in req.url.path)
    consume_body, grant_body = json.loads(consume.content), json.loads(grant.content)
    assert consume_body["idempotencyKey"] == consume.headers["idempotency-key"] and consume_body["amount"] == 3
    assert grant_body["idempotencyKey"] == grant.headers["idempotency-key"] == "order-9"


def test_k2_buy_picks_the_pack_by_its_catalogue_id_and_refuses_an_unknown_one() -> None:
    def api(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/products"):
            return ok([{"id": "prd_77", "catalogKey": "tokens"}])
        if request.url.path.endswith("/credit-packs"):
            return ok({"packs": [{"id": "pck_a", "catalogKey": "small"}, {"id": "pck_b", "catalogKey": "large"}]})
        return ok({"checkoutUrl": "https://pay.test/c/1"}, 201)

    r = Recorder(api)
    out = r.client().credits.buy(
        pack="large", customer_id="cus_1", home_url="https://shop.test/thanks", product="tokens"
    )
    assert out["checkoutUrl"] == "https://pay.test/c/1"
    assert r.requests[-1].url.path == "/api/v1/products/prd_77/credit-packs/pck_b/checkout"
    with pytest.raises(ItajaNotFoundError):
        r.client().credits.buy(pack="huge", customer_id="cus_1", home_url="https://shop.test", product="tokens")


def test_k3_the_calls_the_api_does_not_serve_yet_say_so() -> None:
    r = Recorder([])
    itaja = r.client()
    for call in (
        lambda: itaja.subscribe(customer_id="cus_1", plan="pro"),
        lambda: itaja.check(customer_id="cus_1", feature="export"),
        lambda: itaja.report(customer_id="cus_1", feature="messages"),
    ):
        with pytest.raises(ItajaError) as caught:
            call()
        assert caught.value.code == "NOT_YET_AVAILABLE"
    assert r.requests == []


def test_k4_an_id_with_a_slash_or_a_space_is_encoded() -> None:
    r = Recorder([ok({})])
    r.client().customers.get("user/42 a")
    assert r.requests[0].url.raw_path == b"/api/v1/customers/user%2F42%20a"


def test_push_dry_run_sends_the_flag_and_the_declared_catalogue() -> None:
    from itaja import feature, group, plan

    messages = feature("messages", "metered")
    r = Recorder(lambda _: ok({"summary": {}, "changes": []}))
    itaja = r.client(catalog=[messages, plan("free", group("app", "App"), default=True, includes=[messages(limit=1)])])
    itaja.push(dry_run=True)
    itaja.push()
    dry, real = r.requests
    assert (dry.method, dry.url.params.get("dryRun"), real.url.params.get("dryRun")) == ("PUT", "true", None)
    assert json.loads(real.content) == itaja.catalog
