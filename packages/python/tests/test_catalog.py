"""The catalogue in code → the canonical document ``PUT /v1/catalog`` takes.

HOW IT CAN FAIL (written before the code)

C1. The document is refused by the API's own schema (``spec/catalog.schema.json``).
C2. It is not the document the TypeScript SDK builds for the same declaration
    (``spec/conformance/reference-catalog.json``): ``push`` from two languages would
    report changes that are not there. Same keys, same order.
C3. A plan including an undeclared feature is sent anyway (422 at deploy time), or a
    feature included under another spelling of its name is refused though the API
    sees one feature.
C4. Two default plans in a group, a paid plan without a price, a boolean feature
    with a limit, a metered one without, credits without a pack, an unknown interval
    or licence duration are accepted locally.
C5. A blank or too-long name passes locally and fails on the server.
C6. The same declaration serialises differently twice, or leaks ``None`` values.
C7. An id is accepted or emitted anywhere: features, products, packs and plans are
    identified by their name only.
C8. Two items of one scope whose names differ only by case or spacing pass locally
    (features; products across every type; plans in a group; packs in a credits
    product), or the same plan/pack name in two products is refused.
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
    normalize_name,
    plan,
    to_catalog_document,
)

from .conftest import spec_json

_XOF: Any = {"amount": 1, "currency": "XOF"}
_MONTHLY: Any = {"amount": 1, "currency": "XOF", "interval": "month"}


def declare() -> list[Any]:
    messages = feature("Messages", "metered")
    export = feature("Export", "boolean")
    app = group("My App")
    free = plan("Free", app, default=True, includes=[messages(limit=100, reset="month")])
    pro = plan(
        "Pro",
        app,
        price={"amount": 5000, "currency": "XOF", "interval": "month"},
        trial_days=7,
        includes=[messages(limit=2000, reset="month"), export()],
    )
    tokens = credits("AI tokens", coin_name="Tokens")
    small = credit_pack("100 tokens", tokens, 100, {"amount": 1000, "currency": "XOF"})
    desktop = license("Desktop app", price={"amount": 25000, "currency": "XOF"}, devices=3, duration="days-365")
    return [messages, export, free, pro, small, desktop]


def _keys(value: Any) -> list[str]:
    """Every key of every object in a JSON value, at any depth."""
    if isinstance(value, list):
        return [k for item in value for k in _keys(item)]
    if isinstance(value, dict):
        return [k for key, item in value.items() for k in (key, *_keys(item))]
    return []


def test_c1_the_reference_declaration_validates_against_the_apis_schema() -> None:
    jsonschema.validate(to_catalog_document(declare()), spec_json("catalog.schema.json"))


def test_c1_the_schema_requires_a_non_blank_name_and_no_id() -> None:
    schema = spec_json("catalog.schema.json")
    jsonschema.validate({"features": [{"name": "Export", "type": "boolean"}], "products": []}, schema)
    for bad in ({"type": "boolean"}, {"name": "  ", "type": "boolean"}):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate({"features": [bad], "products": []}, schema)


def test_c2_it_is_the_document_the_typescript_sdk_builds() -> None:
    document = to_catalog_document(declare())
    reference = spec_json("conformance/reference-catalog.json")
    assert document == reference
    # Same keys in the same order: every SDK emits the same bytes.
    assert json.dumps(document) == json.dumps(reference)


def test_c2_list_order_is_declaration_order() -> None:
    document = to_catalog_document(declare())
    assert [p["name"] for p in document["products"]] == ["My App", "AI tokens", "Desktop app"]
    assert [p["name"] for p in document["products"][0]["plans"]] == ["Free", "Pro"]


def test_c6_the_same_declaration_always_serialises_to_the_same_bytes() -> None:
    first = json.dumps(to_catalog_document(declare()))
    assert first == json.dumps(to_catalog_document(declare()))
    assert "null" not in first.replace('"devices": null', "")


def test_c6_unlimited_devices_is_sent_as_null() -> None:
    lic = license("App", price=_XOF, devices=None)
    assert to_catalog_document([lic])["products"][0]["devices"] is None


def test_c3_a_plan_including_an_undeclared_feature_is_refused_locally() -> None:
    messages = feature("Messages", "metered")
    with pytest.raises(ItajaConfigError, match='includes feature "Messages"'):
        to_catalog_document([plan("Free", "My App", default=True, includes=[messages(limit=1)])])


def test_c3_includes_match_the_declared_feature_by_normalised_name() -> None:
    declared = feature("Messages", "metered")
    spelled_otherwise = feature(" messages ", "metered")
    document = to_catalog_document(
        [declared, plan("Free", "My App", default=True, includes=[spelled_otherwise(limit=1)])]
    )
    assert document["features"] == [{"name": "Messages", "type": "metered"}]
    assert document["products"][0]["plans"][0]["includes"] == [{"feature": " messages ", "limit": 1}]


RULES: list[tuple[str, Callable[[], Any], str]] = [
    (
        "two default plans",
        lambda: to_catalog_document([plan("A", "app", default=True), plan("B", "app", default=True)]),
        "two default plans",
    ),
    ("a paid plan without a price", lambda: plan("Pro", "app"), "has no price"),
    ("a boolean feature with a limit", lambda: feature("Export", "boolean")(limit=3), "is boolean"),
    ("a metered feature without a limit", lambda: feature("Messages", "metered")(), "is metered"),
    ("a negative quota", lambda: feature("Messages", "metered")(limit=-1), "is metered"),
    ("an unknown reset", lambda: feature("M", "metered")(limit=1, reset="hour"), "reset"),  # type: ignore[arg-type]
    ("credits without a pack", lambda: to_catalog_document([credits("Tokens")]), "has no pack"),
    (
        "an unknown interval",
        lambda: plan("P", "app", price={"amount": 1, "currency": "XOF", "interval": "decade"}),  # type: ignore[typeddict-item]
        "interval",
    ),
    (
        "a malformed licence duration",
        lambda: license("L", price=_XOF, devices=1, duration="forever"),
        "duration",
    ),
    ("a credit pack with no credits", lambda: credit_pack("P", credits("T"), 0, _XOF), "at least 1"),
    (
        "a currency that is not ISO 4217",
        lambda: license("L", price={"amount": 1, "currency": "CFA!"}, devices=1),
        "ISO 4217",
    ),
    ("a feature type that does not exist", lambda: feature("X", "quota"), "boolean"),  # type: ignore[arg-type]
]


@pytest.mark.parametrize(("label", "declare_it", "message"), RULES, ids=[r[0] for r in RULES])
def test_c4_every_local_rule_the_api_would_enforce_later(
    label: str, declare_it: Callable[[], Any], message: str
) -> None:
    with pytest.raises(ItajaConfigError, match=message) as caught:
        declare_it()
    assert caught.value.code == "CATALOG_DECLARATION_INVALID"


BUILDERS: list[tuple[str, Callable[[str], Any]]] = [
    ("feature", lambda name: feature(name, "boolean")),
    ("product", lambda name: group(name)),
    ("plan", lambda name: plan(name, "app", default=True)),
    ("product", lambda name: credits(name)),
    ("credit pack", lambda name: credit_pack(name, credits("T"), 1, _XOF)),
    ("product", lambda name: license(name, price=_XOF, devices=1)),
]


@pytest.mark.parametrize(("what", "build"), BUILDERS, ids=[f"{i}-{b[0]}" for i, b in enumerate(BUILDERS)])
@pytest.mark.parametrize("bad", ["", "   ", "\t\n", "x" * 201])
def test_c5_a_blank_or_too_long_name_is_refused(what: str, build: Callable[[str], Any], bad: str) -> None:
    with pytest.raises(ItajaConfigError) as caught:
        build(bad)
    assert caught.value.code == "CATALOG_DECLARATION_INVALID"
    assert what in str(caught.value)


@pytest.mark.parametrize(("what", "build"), BUILDERS, ids=[f"{i}-{b[0]}" for i, b in enumerate(BUILDERS)])
def test_c5_a_name_of_200_characters_is_accepted(what: str, build: Callable[[str], Any]) -> None:
    assert build("x" * 200).name == "x" * 200


def test_c7_no_builder_accepts_an_id() -> None:
    with pytest.raises(TypeError):
        feature("Messages", "metered", id="messages")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        group("My App", id="app")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        plan("Pro", "app", id="pro", price=_MONTHLY)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        credits("AI tokens", id="tokens")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        credit_pack("100 tokens", credits("AI tokens"), 100, _XOF, id="small")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        credit_pack("100 tokens", credits("AI tokens"), 100, _XOF, label="100")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        license("Desktop app", id="desktop", price=_XOF, devices=1)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        plan(group="app", default=True)  # type: ignore[call-arg]


def test_c7_the_emitted_document_has_no_id_nor_label_anywhere() -> None:
    keys = _keys(to_catalog_document(declare()))
    assert "id" not in keys
    assert "label" not in keys


def test_c7_a_name_is_emitted_as_declared() -> None:
    document = to_catalog_document([plan("  Pro  Max ", " My App ", default=True)])
    assert document["products"][0]["name"] == " My App "
    assert document["products"][0]["plans"][0]["name"] == "  Pro  Max "


@pytest.mark.parametrize("twin", ["messages", " MESSAGES ", "Messages\t"])
def test_c8_features_that_differ_only_by_case_or_spacing_are_duplicates(twin: str) -> None:
    with pytest.raises(ItajaConfigError, match=r'Feature ".*" is declared twice'):
        to_catalog_document([feature("Messages", "metered"), feature(twin, "metered")])


def test_c8_the_same_feature_listed_twice_is_one_feature() -> None:
    messages = feature("Messages", "metered")
    assert to_catalog_document([messages, messages])["features"] == [{"name": "Messages", "type": "metered"}]


PRODUCT_TWINS: list[tuple[str, list[Any]]] = [
    ("group vs licence", [plan("Free", "My App", default=True), license(" my  app ", price=_XOF, devices=1)]),
    (
        "credits vs group",
        [credit_pack("P", credits("AI tokens"), 1, _XOF), plan("Free", "AI TOKENS", default=True)],
    ),
    ("two licences", [license("Desktop app", price=_XOF, devices=1), license("desktop app", price=_XOF, devices=2)]),
    (
        "one group declared two ways",
        [plan("Free", group("App"), default=True), plan("Pro", group("App", "other"), price=_MONTHLY)],
    ),
]


@pytest.mark.parametrize(("label", "items"), PRODUCT_TWINS, ids=[t[0] for t in PRODUCT_TWINS])
def test_c8_products_share_one_namespace_across_types(label: str, items: list[Any]) -> None:
    with pytest.raises(ItajaConfigError, match=r'Product ".*" is declared twice'):
        to_catalog_document(items)


def test_c8_a_group_shared_by_its_plans_or_named_by_a_string_is_one_product() -> None:
    app = group("My App")
    document = to_catalog_document([plan("Free", app, default=True), plan("Pro", "My App", price=_MONTHLY)])
    assert len(document["products"]) == 1
    assert len(document["products"][0]["plans"]) == 2


@pytest.mark.parametrize("twin", ["pro", "PRO", " Pro ", "pRo"])
def test_c8_plans_that_differ_only_by_case_or_spacing_are_duplicates(twin: str) -> None:
    with pytest.raises(ItajaConfigError, match="declared twice") as caught:
        to_catalog_document([plan("Pro", "app", price=_MONTHLY), plan(twin, "app", price=_MONTHLY)])
    assert caught.value.code == "CATALOG_DECLARATION_INVALID"


def test_c8_inner_whitespace_is_collapsed_when_comparing() -> None:
    with pytest.raises(ItajaConfigError, match="declared twice"):
        to_catalog_document([plan("Pro Max", "app", price=_MONTHLY), plan("pro   max", "app", price=_MONTHLY)])


def test_c8_the_same_plan_name_in_two_groups_is_allowed() -> None:
    document = to_catalog_document([plan("Pro", "app", price=_MONTHLY), plan("Pro", "api", price=_MONTHLY)])
    assert [[p["name"] for p in product["plans"]] for product in document["products"]] == [["Pro"], ["Pro"]]
    jsonschema.validate(document, spec_json("catalog.schema.json"))


@pytest.mark.parametrize("twin", ["100 TOKENS", " 100  tokens "])
def test_c8_packs_that_differ_only_by_case_or_spacing_are_duplicates(twin: str) -> None:
    tokens = credits("AI tokens")
    with pytest.raises(ItajaConfigError, match=f'Credit pack "{twin}" is declared twice in "AI tokens"'):
        to_catalog_document([credit_pack("100 tokens", tokens, 100, _XOF), credit_pack(twin, tokens, 200, _XOF)])


def test_c8_the_same_pack_name_in_two_credits_products_is_allowed() -> None:
    document = to_catalog_document(
        [
            credit_pack("100 tokens", credits("AI tokens"), 100, _XOF),
            credit_pack("100 tokens", credits("Image credits"), 100, _XOF),
        ]
    )
    assert [p["name"] for p in document["products"]] == ["AI tokens", "Image credits"]
    jsonschema.validate(document, spec_json("catalog.schema.json"))


def test_errors_name_the_item() -> None:
    with pytest.raises(ItajaConfigError, match='Plan "Pro Max" has no price'):
        plan("Pro Max", "app")


def test_normalize_name_composes_trims_collapses_and_lowercases() -> None:
    assert normalize_name("  AI \t  TOKENS ") == "ai tokens"
    # "é" typed as e + combining acute is the same name as the precomposed "é".
    assert normalize_name("Cafe\u0301") == normalize_name("CAF\u00c9")
    assert normalize_name("Pro") == normalize_name(" pro ")
