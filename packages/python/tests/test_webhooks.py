"""Webhook verification: Standard Webhooks (``webhook-id`` / ``webhook-timestamp`` /
``webhook-signature``), the only scheme Itaja signs with.

HOW IT CAN FAIL (written before the code)

W1.  A signature the delivery service produced is refused (the two sides disagree on
     the signed content, the key, the encoding or the header format). Covered by the
     shared vectors of ``spec/signature-vectors.json``, one per kind of secret, and
     by the official ``standardwebhooks`` package (PyPI), which must sign what we
     sign and accept what we sign (the Node suite does the same with the npm one).
W1b. A legacy ``whsec_<48 hex>`` secret stops working: its key must be the 36 bytes
     the hex text decodes to AS BASE64, not the hex bytes, not the text.
W1c. A secret that is not base64 is refused or mis-keyed, instead of falling back to
     its UTF-8 bytes like the emitter does.
W2.  A tampered body, a body re-serialised by a JSON parser, another ``webhook-id``,
     or a signature made with another secret is accepted.
W3.  A delivery older (or newer) than the tolerance is accepted: a captured request
     replays forever.
W4.  A missing header (any of the three), a non-numeric timestamp or a header with no
     ``v1`` entry raises something else than ItajaSignatureError (a 500 instead of a
     400), or shares one code.
W5.  During a secret rotation (``v1,<new> v1,<old>``, space-separated) the delivery is
     refused; or an entry of an unknown version breaks the parse.
W6.  A signature that is not base64 or of the wrong length crashes instead of failing.
W7.  Headers as a framework gives them (bytes, lists, any casing) are not read.
W8.  The removed ``x-itaja-signature`` / ``x-itaja-timestamp`` scheme is still
     accepted, alone or as a fallback.
W9.  The body is decoded before it is signed: two different byte sequences that
     decode to the same text pass for the same body.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from typing import Any

import pytest
from standardwebhooks.webhooks import Webhook, WebhookVerificationError

from itaja import ItajaSignatureError, construct_event, sign_payload
from itaja.webhooks import ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER

from .conftest import spec_json

VECTORS: list[dict[str, str]] = spec_json("signature-vectors.json")["vectors"]


def of_kind(kind: str) -> dict[str, str]:
    return next(v for v in VECTORS if v["kind"] == kind)


FIRST = of_kind("base64-secret")
LEGACY = of_kind("legacy-hex-secret")
SECRET = FIRST["secret"]
AT = int(FIRST["timestamp"])


def headers_of(v: dict[str, str], **override: str) -> dict[str, str]:
    headers = {"webhook-id": v["id"], "webhook-timestamp": v["timestamp"], "webhook-signature": v["signature"]}
    return {**headers, **{name.replace("_", "-"): value for name, value in override.items()}}


def mac(key: bytes, v: dict[str, str]) -> str:
    content = f"{v['id']}.{v['timestamp']}.{v['body']}".encode()
    return "v1," + base64.b64encode(hmac.new(key, content, hashlib.sha256).digest()).decode()


def code_of(**kwargs: Any) -> str:
    try:
        construct_event(**kwargs)
    except ItajaSignatureError as error:
        assert error.status == 400
        return error.code
    return "ACCEPTED"


def check(headers: dict[str, Any], *, payload: bytes | str = FIRST["body"], secret: str = SECRET, now: int = AT) -> str:
    return code_of(payload=payload, headers=headers, secret=secret, now=now)


def test_the_header_names_are_standard_webhooks_own() -> None:
    assert (ID_HEADER, TIMESTAMP_HEADER, SIGNATURE_HEADER) == ("webhook-id", "webhook-timestamp", "webhook-signature")


def test_the_vectors_cover_every_kind_of_secret() -> None:
    assert {v["kind"] for v in VECTORS} == {"base64-secret", "legacy-hex-secret", "rotation", "utf8-fallback-secret"}


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_w1_accepts_the_shared_vector(vector: dict[str, str]) -> None:
    event = construct_event(vector["body"], headers_of(vector), vector["secret"], now=int(vector["timestamp"]))
    assert event.id == json.loads(vector["body"])["id"]


@pytest.mark.parametrize(
    "vector", [v for v in VECTORS if v["kind"] != "rotation"], ids=lambda v: v["name"] if isinstance(v, dict) else None
)
def test_w1_our_signer_reproduces_the_shared_vector(vector: dict[str, str]) -> None:
    signed = sign_payload(vector["body"], vector["secret"], id=vector["id"], timestamp=int(vector["timestamp"]))
    assert signed == headers_of(vector)


def test_w1_bytes_body_and_the_event_fields() -> None:
    event = construct_event(
        FIRST["body"].encode(), {**headers_of(FIRST), "webhook-topic": "checkout.paid"}, SECRET, now=AT
    )
    assert (event.type, event.mode, event.data["amount"]) == ("checkout.paid", "live", 5000)


def test_w1b_a_legacy_hex_secret_is_keyed_by_its_base64_decoding() -> None:
    text = LEGACY["secret"].removeprefix("whsec_")
    assert len(text) == 48 and set(text) <= set("0123456789abcdef")
    key = base64.b64decode(text, validate=True)
    assert len(key) == 36
    assert mac(key, LEGACY) == LEGACY["signature"]
    at = int(LEGACY["timestamp"])
    # Neither the hex bytes nor the text itself is the key.
    for wrong in (bytes.fromhex(text), text.encode(), LEGACY["secret"].encode()):
        forged = headers_of(LEGACY, webhook_signature=mac(wrong, LEGACY))
        assert check(forged, payload=LEGACY["body"], secret=LEGACY["secret"], now=at) == "SIGNATURE_MISMATCH"


@pytest.mark.parametrize("secret", ["whsec_abcde", "whsec_AB==", "whsec_", "whsec_====", "plain text secret"])
def test_w1c_a_secret_that_is_not_canonical_base64_is_keyed_by_its_utf8_bytes(secret: str) -> None:
    fallback = of_kind("utf8-fallback-secret")
    assert mac(fallback["secret"].removeprefix("whsec_").encode(), fallback) == fallback["signature"]

    body = '{"id":"e1","type":"t","data":{}}'
    mine = sign_payload(body, secret, id="m1", timestamp=AT)
    expected = mac(secret.removeprefix("whsec_").encode(), {"id": "m1", "timestamp": str(AT), "body": body})
    assert mine["webhook-signature"] == expected
    assert construct_event(body, mine, secret, now=AT).id == "e1"


def test_w2_refuses_a_tampered_body_a_reserialised_body_another_id_and_another_secret() -> None:
    tampered = FIRST["body"].replace("5000", "50000")
    pretty = json.dumps(json.loads(FIRST["body"]), indent=2)
    assert check(headers_of(FIRST), payload=tampered) == "SIGNATURE_MISMATCH"
    assert check(headers_of(FIRST), payload=pretty) == "SIGNATURE_MISMATCH"
    assert check(headers_of(FIRST, webhook_id="itaja_evt_other")) == "SIGNATURE_MISMATCH"
    assert check(headers_of(FIRST), secret="whsec_other") == "SIGNATURE_MISMATCH"
    assert check(headers_of(FIRST), secret=LEGACY["secret"]) == "SIGNATURE_MISMATCH"


def test_w3_refuses_outside_the_tolerance_both_ways_and_the_tolerance_is_configurable() -> None:
    def run(now: int, tolerance: int = 300) -> str:
        return code_of(payload=FIRST["body"], headers=headers_of(FIRST), secret=SECRET, now=now, tolerance=tolerance)

    assert run(AT + 300) == "ACCEPTED"
    assert run(AT - 300) == "ACCEPTED"
    assert run(AT + 301) == "TIMESTAMP_OUT_OF_TOLERANCE"
    assert run(AT - 301) == "TIMESTAMP_OUT_OF_TOLERANCE"
    assert run(AT + 301, 600) == "ACCEPTED"
    assert run(AT + 11, 10) == "TIMESTAMP_OUT_OF_TOLERANCE"
    # The timestamp is signed: moving it into the window does not help.
    assert check(headers_of(FIRST, webhook_timestamp=str(AT + 301)), now=AT + 301) == "SIGNATURE_MISMATCH"


def test_w4_a_malformed_delivery_is_a_signature_error_with_its_own_code() -> None:
    def without(name: str) -> dict[str, str]:
        return {key: value for key, value in headers_of(FIRST).items() if key != name}

    assert check({}) == "SIGNATURE_MISSING"
    assert check(without("webhook-id")) == "SIGNATURE_MISSING"
    assert check(without("webhook-timestamp")) == "SIGNATURE_MISSING"
    assert check(without("webhook-signature")) == "SIGNATURE_MISSING"
    for bad in ("yesterday", "1760500000.5", "-1760500000", " 1760500000", "0x10", "١٢٣"):
        assert check(headers_of(FIRST, webhook_timestamp=bad)) == "TIMESTAMP_INVALID", bad
    for bad in (FIRST["signature"].replace("v1,", "v2,"), "v1", "v1,", FIRST["signature"][3:], "v1a,abc v2,def"):
        assert check(headers_of(FIRST, webhook_signature=bad)) == "SIGNATURE_SCHEME_UNSUPPORTED", bad
    assert check(headers_of(FIRST), secret="") == "WEBHOOK_SECRET_MISSING"
    body = "not json"
    signed = sign_payload(body, SECRET, timestamp=AT)
    assert code_of(payload=body, headers=signed, secret=SECRET, now=AT) == "PAYLOAD_INVALID"


def test_w5_during_a_secret_rotation_one_matching_entry_is_enough() -> None:
    assert len(of_kind("rotation")["signature"].split(" ")) == 2
    current = FIRST["signature"]
    stale = sign_payload(FIRST["body"], "whsec_b2xkIHNlY3JldA==", id=FIRST["id"], timestamp=AT)["webhook-signature"]

    def run(signature: str) -> str:
        return check(headers_of(FIRST, webhook_signature=signature))

    assert run(f"{stale} {current}") == "ACCEPTED"
    assert run(f"{current} {stale}") == "ACCEPTED"
    assert run(stale) == "SIGNATURE_MISMATCH"
    assert run(f"{stale} {stale}") == "SIGNATURE_MISMATCH"
    # Entries of another version are skipped, wherever they sit.
    assert run(f"v2,{current[3:]}") == "SIGNATURE_SCHEME_UNSUPPORTED"
    assert run(f"v1a,AAAA {current} v2,BBBB") == "ACCEPTED"
    assert run(f"v2,{current[3:]} {stale}") == "SIGNATURE_MISMATCH"


@pytest.mark.parametrize("junk", ["!!!not-base64!!!", "AAAA", base64.b64encode(b"x" * 64).decode()])
def test_w6_a_signature_that_is_not_base64_or_the_wrong_length_fails_cleanly(junk: str) -> None:
    assert check(headers_of(FIRST, webhook_signature=f"v1,{junk} v1,{junk}")) == "SIGNATURE_MISMATCH"


def test_w7_headers_in_any_casing_as_lists_or_bytes() -> None:
    as_lists = {
        "Webhook-Id": [FIRST["id"]],
        "WEBHOOK-TIMESTAMP": [FIRST["timestamp"]],
        "Webhook-Signature": [FIRST["signature"]],
    }
    as_bytes = {name: value.encode() for name, value in headers_of(FIRST).items()}
    assert construct_event(FIRST["body"], as_lists, SECRET, now=AT).type == "checkout.paid"
    assert construct_event(FIRST["body"], as_bytes, SECRET, now=AT).type == "checkout.paid"


def test_w8_the_removed_x_itaja_scheme_is_refused_alone_or_next_to_the_new_headers() -> None:
    digest = hmac.new(SECRET.encode(), f"{AT}.{FIRST['body']}".encode(), hashlib.sha256).digest()
    old = {"x-itaja-timestamp": FIRST["timestamp"], "x-itaja-signature": "v1," + base64.b64encode(digest).decode()}
    assert check(old) == "SIGNATURE_MISSING"
    wrong_new = headers_of(FIRST, webhook_signature="v1," + base64.b64encode(b"\x00" * 32).decode())
    assert check({**old, **wrong_new}) == "SIGNATURE_MISMATCH"


def test_w9_the_signature_covers_the_raw_bytes_not_their_decoded_text() -> None:
    def body(last: int) -> bytes:
        return b'{"id":"evt_raw","type":"t","data":{"label":"' + bytes([last]) + b'"}}'

    a, b = body(0xFF), body(0xFE)
    assert a.decode("utf-8", "replace") == b.decode("utf-8", "replace")
    headers = sign_payload(a, SECRET, id="m_raw", timestamp=AT)
    # The signature of `a` holds for `a` (then its JSON is refused as such), not for `b`.
    assert check(headers, payload=a) == "PAYLOAD_INVALID"
    assert check(headers, payload=b) == "SIGNATURE_MISMATCH"


def test_sign_payload_returns_the_three_headers_and_a_fresh_id_per_call() -> None:
    a, b = sign_payload("{}", SECRET), sign_payload("{}", SECRET)
    assert sorted(a) == ["webhook-id", "webhook-signature", "webhook-timestamp"]
    assert a["webhook-id"] != b["webhook-id"] and a["webhook-timestamp"].isascii() and a["webhook-timestamp"].isdigit()
    assert sign_payload("{}", SECRET, id="msg_fixed")["webhook-id"] == "msg_fixed"


def test_what_we_sign_we_verify() -> None:
    body = '{"id":"itaja_evt_1","type":"credits.low","data":{"balance":3}}'
    assert construct_event(body, sign_payload(body, "whsec_mine"), "whsec_mine").id == "itaja_evt_1"


# ── Agreement with the official ``standardwebhooks`` package ────────────────────────
# Its key derivation has no UTF-8 fallback, so only base64 secrets (new and legacy hex)
# are compared; the fallback is pinned by W1c and the shared vectors.
OFFICIAL = [v for v in VECTORS if v["kind"] in ("base64-secret", "legacy-hex-secret", "rotation")]


@pytest.mark.parametrize("vector", OFFICIAL, ids=[v["name"] for v in OFFICIAL])
def test_w1_the_official_library_signs_the_shared_vector_identically(vector: dict[str, str]) -> None:
    at = datetime.fromtimestamp(int(vector["timestamp"]), tz=timezone.utc)
    official = Webhook(vector["secret"]).sign(vector["id"], at, vector["body"])
    assert official in vector["signature"].split(" ")


@pytest.mark.parametrize("secret", [SECRET, LEGACY["secret"]], ids=["base64", "legacy-hex"])
def test_w1_each_side_accepts_what_the_other_signs_and_refuses_the_same_tampering(secret: str) -> None:
    now = int(time.time())
    body = FIRST["body"]
    mine = sign_payload(body, secret, id="msg_cross", timestamp=now)
    assert Webhook(secret).verify(body, mine)["id"] == "itaja_evt_txn_1"

    theirs = {
        "webhook-id": "msg_cross",
        "webhook-timestamp": str(now),
        "webhook-signature": Webhook(secret).sign("msg_cross", datetime.fromtimestamp(now, tz=timezone.utc), body),
    }
    assert construct_event(body, theirs, secret, now=now).id == "itaja_evt_txn_1"

    tampered = body.replace("5000", "50000")
    with pytest.raises(WebhookVerificationError):
        Webhook(secret).verify(tampered, mine)
    assert code_of(payload=tampered, headers=mine, secret=secret, now=now) == "SIGNATURE_MISMATCH"
