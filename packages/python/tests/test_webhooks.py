"""Webhook verification (``x-itaja-signature`` / ``x-itaja-timestamp``).

HOW IT CAN FAIL (written before the code)

W1. A signature Itaja's backend produced is refused (the two sides disagree on the
    signed content, the encoding or the header format). The vectors are signed by
    the backend's own ``signOutboundWebhook``.
W2. A tampered body, a body re-serialised by a JSON parser, or a signature made with
    another secret is accepted.
W3. A delivery older (or newer) than the tolerance is accepted: a captured request
    replays forever.
W4. A missing header, a non-numeric timestamp or another scheme than ``v1`` raises
    something else than ItajaSignatureError (a 500 instead of a 400).
W5. During a secret rotation (``v1,<old>,<new>``) the delivery is refused.
W6. A signature that is not base64 or of the wrong length crashes instead of failing.
W7. Headers as a framework gives them (bytes, lists, any casing) are not read.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

import pytest

from itaja import ItajaSignatureError, construct_event, sign_payload

from .conftest import spec_json

VECTORS = spec_json("signature-vectors.json")
SECRET: str = VECTORS["secret"]
FIRST: dict[str, str] = VECTORS["vectors"][0]
AT = int(FIRST["timestamp"])


def headers_of(v: dict[str, str]) -> dict[str, str]:
    return {"x-itaja-signature": v["signature"], "x-itaja-timestamp": v["timestamp"]}


def code_of(**kwargs: Any) -> str:
    try:
        construct_event(**kwargs)
    except ItajaSignatureError as error:
        assert error.status == 400
        return error.code
    return "ACCEPTED"


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=[v["name"] for v in VECTORS["vectors"]])
def test_w1_accepts_the_backends_own_signature(vector: dict[str, str]) -> None:
    event = construct_event(vector["body"], headers_of(vector), SECRET, now=int(vector["timestamp"]))
    assert event.id == json.loads(vector["body"])["id"]


def test_w1_bytes_body_and_the_event_fields() -> None:
    event = construct_event(FIRST["body"].encode(), headers_of(FIRST), SECRET, now=AT)
    assert (event.type, event.mode, event.data["amount"]) == ("checkout.paid", "live", 5000)


def test_w2_refuses_a_tampered_body_a_reserialised_body_and_another_secret() -> None:
    tampered = FIRST["body"].replace("5000", "50000")
    pretty = json.dumps(json.loads(FIRST["body"]), indent=2)
    assert code_of(payload=tampered, headers=headers_of(FIRST), secret=SECRET, now=AT) == "SIGNATURE_MISMATCH"
    assert code_of(payload=pretty, headers=headers_of(FIRST), secret=SECRET, now=AT) == "SIGNATURE_MISMATCH"
    assert (
        code_of(payload=FIRST["body"], headers=headers_of(FIRST), secret="whsec_other", now=AT) == "SIGNATURE_MISMATCH"
    )


def test_w3_refuses_outside_the_five_minute_tolerance_both_ways() -> None:
    def run(now: int) -> str:
        return code_of(payload=FIRST["body"], headers=headers_of(FIRST), secret=SECRET, now=now)

    assert run(AT + 300) == "ACCEPTED"
    assert run(AT + 301) == "TIMESTAMP_OUT_OF_TOLERANCE"
    assert run(AT - 301) == "TIMESTAMP_OUT_OF_TOLERANCE"


def test_w4_a_malformed_delivery_is_a_signature_error_never_anything_else() -> None:
    def check(headers: dict[str, str], secret: str = SECRET) -> str:
        return code_of(payload=FIRST["body"], headers=headers, secret=secret, now=AT)

    assert check({}) == "SIGNATURE_MISSING"
    assert check({"x-itaja-signature": FIRST["signature"]}) == "SIGNATURE_MISSING"
    assert check({"x-itaja-signature": FIRST["signature"], "x-itaja-timestamp": "yesterday"}) == "TIMESTAMP_INVALID"
    assert (
        check({"x-itaja-signature": "v2,abc", "x-itaja-timestamp": FIRST["timestamp"]})
        == "SIGNATURE_SCHEME_UNSUPPORTED"
    )
    assert check({"x-itaja-signature": "v1", "x-itaja-timestamp": FIRST["timestamp"]}) == "SIGNATURE_SCHEME_UNSUPPORTED"
    assert check(headers_of(FIRST), secret="") == "WEBHOOK_SECRET_MISSING"
    body = "not json"
    signed = sign_payload(body, SECRET, timestamp=AT)
    assert code_of(payload=body, headers=signed, secret=SECRET, now=AT) == "PAYLOAD_INVALID"


def test_w5_during_a_secret_rotation_one_matching_signature_is_enough() -> None:
    current = FIRST["signature"][3:]
    stale = base64.b64encode(hmac.new(b"whsec_old", f"{AT}.{FIRST['body']}".encode(), hashlib.sha256).digest()).decode()

    def both(*parts: str) -> dict[str, str]:
        return {"x-itaja-signature": "v1," + ",".join(parts), "x-itaja-timestamp": FIRST["timestamp"]}

    assert code_of(payload=FIRST["body"], headers=both(stale, current), secret=SECRET, now=AT) == "ACCEPTED"
    assert code_of(payload=FIRST["body"], headers=both(current, stale), secret=SECRET, now=AT) == "ACCEPTED"
    assert code_of(payload=FIRST["body"], headers=both(stale), secret=SECRET, now=AT) == "SIGNATURE_MISMATCH"


@pytest.mark.parametrize("junk", ["!!!not-base64!!!", "AAAA", base64.b64encode(b"x" * 64).decode()])
def test_w6_a_signature_that_is_not_base64_or_the_wrong_length_fails_cleanly(junk: str) -> None:
    headers = {"x-itaja-signature": f"v1,{junk}", "x-itaja-timestamp": FIRST["timestamp"]}
    assert code_of(payload=FIRST["body"], headers=headers, secret=SECRET, now=AT) == "SIGNATURE_MISMATCH"


def test_w7_headers_in_any_casing_as_lists_or_bytes() -> None:
    as_lists = {"X-Itaja-Signature": [FIRST["signature"]], "X-ITAJA-TIMESTAMP": [FIRST["timestamp"]]}
    as_bytes = {"x-itaja-signature": FIRST["signature"].encode(), "x-itaja-timestamp": FIRST["timestamp"].encode()}
    assert construct_event(FIRST["body"], as_lists, SECRET, now=AT).type == "checkout.paid"
    assert construct_event(FIRST["body"], as_bytes, SECRET, now=AT).type == "checkout.paid"


def test_what_we_sign_we_verify() -> None:
    body = '{"id":"itaja_evt_1","type":"credits.low","data":{"balance":3}}'
    assert construct_event(body, sign_payload(body, "whsec_mine"), "whsec_mine").id == "itaja_evt_1"
