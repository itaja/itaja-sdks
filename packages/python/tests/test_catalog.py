"""The catalogue in code → the canonical document ``PUT /v1/catalog`` takes.

HOW IT CAN FAIL (written before the code)

C1. The document is refused by the API's own schema (``spec/catalog.schema.json``).
C2. It is not the document the TypeScript SDK builds for the same declaration
    (``spec/conformance/reference-catalog.json``): ``push`` from two languages would
    report changes that are not there. Key order inside an object does not matter;
    list order does.
C3. A plan including an undeclared feature is sent anyway (422 at deploy time).
C4. Two default plans in a group, a paid plan without a price, a boolean feature
    with a limit, a metered one without, credits without a pack, a product id used
    twice, an unknown interval or licence duration are accepted locally.
C5. An invalid id passes locally and fails on the server.
C6. The same declaration serialises differently twice, or leaks ``None`` values.
C7. A plan is sent with an id, or without a name: the name is its identity inside its
    product (trimmed, inner whitespace collapsed, case-insensitive). A blank or too-long
    name, or two names that only differ by case or spacing in one group, pass locally.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import jsonschema
import pytest

from itaja import (
    ItajaConfigError,
    credit_pack,
    credits,
    feature,
    group,
    license,
    plan,
    to_catalog_document,
)

from .conftest import spec_json


def declare() -> list[Any]:
    messages = feature("messages", "metered")
    export = feature("export", "boolean")
    app = group("app", "My App")
    free = plan("Free", app, default=True, includes=[messages(limit=100, reset="month")])
    pro = plan(
        "Pro",
        app,
        price={"amount": 5000, "currency": "XOF", "interval": "month"},
        trial_days=7,
        includes=[messages(limit=2000, reset="month"), export()],
    )
    tokens = credits("tokens", "AI tokens", coin_name="Tokens")
    small = credit_pack("small", tokens, 100, {"amount": 1000, "currency": "XOF"})
    desktop = license(
        "desktop", "Desktop app", price={"amount": 25000, "currency": "XOF"}, devices=3, duration="days-365"
    )
    return [messages, export, free, pro, small, desktop]


def test_c1_the_reference_declaration_validates_against_the_apis_schema() -> None:
    jsonschema.validate(to_catalog_document(declare()), spec_json("catalog.schema.json"))


def test_c2_it_is_the_document_the_typescript_sdk_builds() -> None:
    assert to_catalog_document(declare()) == spec_json("conformance/reference-catalog.json")


def test_c2_list_order_is_declaration_order() -> None:
    document = to_catalog_document(declare())
    assert [p["id"] for p in document["products"]] == ["app", "tokens", "desktop"]
    assert [p["name"] for p in document["products"][0]["plans"]] == ["Free", "Pro"]


def test_c6_the_same_declaration_always_serialises_to_the_same_bytes() -> None:
    first = json.dumps(to_catalog_document(declare()))
    assert first == json.dumps(to_catalog_document(declare()))
    assert "null" not in first.replace('"devices": null', "")


def test_c6_unlimited_devices_is_sent_as_null() -> None:
    lic = license("app", "App", price={"amount": 1, "currency": "XOF"}, devices=None)
    assert to_catalog_document([lic])["products"][0]["devices"] is None


def test_c3_a_plan_including_an_undeclared_feature_is_refused_locally() -> None:
    messages = feature("messages", "metered")
    with pytest.raises(ItajaConfigError, match='includes feature "messages"'):
        to_catalog_document([plan("Free", "app", default=True, includes=[messages(limit=1)])])


RULES: list[tuple[str, Callable[[], Any], str]] = [
    (
        "two default plans",
        lambda: to_catalog_document([plan("A", "app", default=True), plan("B", "app", default=True)]),
        "two default plans",
    ),
    ("a paid plan without a price", lambda: plan("Pro", "app"), "has no price"),
    ("a boolean feature with a limit", lambda: feature("export", "boolean")(limit=3), "is boolean"),
    ("a metered feature without a limit", lambda: feature("messages", "metered")(), "is metered"),
    ("a negative quota", lambda: feature("messages", "metered")(limit=-1), "is metered"),
    ("an unknown reset", lambda: feature("m", "metered")(limit=1, reset="hour"), "reset"),  # type: ignore[arg-type]
    ("credits without a pack", lambda: to_catalog_document([credits("tokens", "Tokens")]), "has no pack"),
    (
        "a product id used twice",
        lambda: to_catalog_document(
            [license("x", "X", price={"amount": 1, "currency": "XOF"}, devices=1), credits("x", "X")]
        ),
        "used twice",
    ),
    (
        "a plan declared twice",
        lambda: to_catalog_document(
            [
                plan("A", "app", default=True),
                plan("A", "app", price={"amount": 1, "currency": "XOF", "interval": "month"}),
            ]
        ),
        "declared twice",
    ),
    (
        "an unknown interval",
        lambda: plan("P", "app", price={"amount": 1, "currency": "XOF", "interval": "decade"}),  # type: ignore[typeddict-item]
        "interval",
    ),
    (
        "a malformed licence duration",
        lambda: license("l", "L", price={"amount": 1, "currency": "XOF"}, devices=1, duration="forever"),
        "duration",
    ),
    (
        "a credit pack with no credits",
        lambda: credit_pack("p", credits("t", "T"), 0, {"amount": 1, "currency": "XOF"}),
        "at least 1",
    ),
    (
        "a currency that is not ISO 4217",
        lambda: license("l", "L", price={"amount": 1, "currency": "CFA!"}, devices=1),
        "ISO 4217",
    ),
    ("a feature type that does not exist", lambda: feature("x", "quota"), "boolean"),  # type: ignore[arg-type]
]


@pytest.mark.parametrize(("label", "declare_it", "message"), RULES, ids=[r[0] for r in RULES])
def test_c4_every_local_rule_the_api_would_enforce_later(
    label: str, declare_it: Callable[[], Any], message: str
) -> None:
    with pytest.raises(ItajaConfigError, match=message) as caught:
        declare_it()
    assert caught.value.code == "CATALOG_DECLARATION_INVALID"


@pytest.mark.parametrize("bad", ["", "my plan", "-pro", "a" * 65, "pré"])
def test_c5_ids_the_api_would_refuse_are_refused_at_declaration(bad: str) -> None:
    with pytest.raises(ItajaConfigError):
        feature(bad, "boolean")


_MONTHLY: Any = {"amount": 1, "currency": "XOF", "interval": "month"}


@pytest.mark.parametrize("bad", ["", "   ", "\t\n", "x" * 201])
def test_c7_a_blank_or_too_long_plan_name_is_refused(bad: str) -> None:
    with pytest.raises(ItajaConfigError) as caught:
        plan(bad, "app", default=True)
    assert caught.value.code == "CATALOG_DECLARATION_INVALID"


def test_c7_the_name_is_required_and_has_no_id_keyword() -> None:
    with pytest.raises(TypeError):
        plan(group="app", default=True)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        plan("Pro", "app", id="pro", price=_MONTHLY)  # type: ignore[call-arg]


def test_c7_a_name_of_200_characters_is_accepted_and_trimmed() -> None:
    assert plan("  " + "x" * 200 + " ", "app", default=True).name == "x" * 200


@pytest.mark.parametrize("twin", ["pro", "PRO", " Pro ", "pRo"])
def test_c7_names_that_differ_only_by_case_or_spacing_are_duplicates(twin: str) -> None:
    with pytest.raises(ItajaConfigError, match="declared twice") as caught:
        to_catalog_document([plan("Pro", "app", price=_MONTHLY), plan(twin, "app", price=_MONTHLY)])
    assert caught.value.code == "CATALOG_DECLARATION_INVALID"


def test_c7_inner_whitespace_is_collapsed_when_comparing() -> None:
    with pytest.raises(ItajaConfigError, match="declared twice"):
        to_catalog_document([plan("Pro Max", "app", price=_MONTHLY), plan("pro   max", "app", price=_MONTHLY)])


def test_c7_the_same_name_in_two_groups_is_allowed() -> None:
    document = to_catalog_document([plan("Pro", "app", price=_MONTHLY), plan("Pro", "api", price=_MONTHLY)])
    assert [[p["name"] for p in product["plans"]] for product in document["products"]] == [["Pro"], ["Pro"]]


def test_c7_the_emitted_document_has_no_plan_id() -> None:
    document = to_catalog_document(declare())
    plans = [p for product in document["products"] for p in product.get("plans", [])]
    assert plans and all("id" not in p and p["name"] for p in plans)
    jsonschema.validate(document, spec_json("catalog.schema.json"))


def test_c7_errors_name_the_plan() -> None:
    with pytest.raises(ItajaConfigError, match='Plan "Pro Max" has no price'):
        plan("Pro Max", "app")
