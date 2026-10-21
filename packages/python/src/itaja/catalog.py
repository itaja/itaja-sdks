"""The catalogue in code: one builder per way of selling, and ``to_catalog_document``
that turns what you declared into the canonical JSON ``PUT /v1/catalog`` takes
(``spec/catalog.schema.json``).

Everything is identified by its **name** (``"Messages"``, ``"My App"``, ``"AI tokens"``,
``"Pro"``): there is no id to choose. Names are compared trimmed, inner whitespace collapsed
and case-insensitively; Itaja assigns the system ids. Amounts are in **major units** of their
currency, as on every product route of the API (``5000`` XOF, ``9.99`` EUR).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from .errors import ItajaConfigError

Interval = Literal["week", "month", "quarter", "year"]
Reset = Literal["day", "week", "month", "year"]

INTERVALS: tuple[str, ...] = ("week", "month", "quarter", "year")
RESETS: tuple[str, ...] = ("day", "week", "month", "year")
#: The longest name the API accepts, for every catalogue item.
NAME_MAX_LENGTH = 200
_DURATION = re.compile(r"^(lifetime|days-\d+|from-first-activation-days-\d+)$")
_CURRENCY = re.compile(r"^[A-Za-z]{3}$")


class Money(TypedDict):
    """``{"amount": 5000, "currency": "XOF"}``: major units, ISO 4217."""

    amount: float
    currency: str


class _PriceRequired(TypedDict):
    amount: float
    currency: str
    interval: Interval


class Price(_PriceRequired, total=False):
    """A recurring price: ``{"amount": 5000, "currency": "XOF", "interval": "month"}``."""

    intervalCount: int


class Inclusion(TypedDict, total=False):
    #: The included feature's name.
    feature: str
    limit: int
    reset: Reset


def normalize_name(name: str) -> str:
    """A catalogue item's identity: Unicode NFC, trimmed, inner whitespace collapsed to one space,
    lower-cased, exactly as the API compares names (and stores them as ``catalogKey``)."""
    return " ".join(unicodedata.normalize("NFC", name).split()).lower()


def _error(message: str) -> ItajaConfigError:
    return ItajaConfigError(message, code="CATALOG_DECLARATION_INVALID")


def _assert_name(name: Any, what: str, example: str) -> None:
    if not isinstance(name, str) or not name.strip():
        raise _error(f"A {what} needs a name: it is its identity (there is no id), e.g. {example}.")
    if len(name) > NAME_MAX_LENGTH:
        raise _error(f'The {what} name "{name[:40]}..." is {len(name)} characters long: at most {NAME_MAX_LENGTH}.')


def _assert_money(price: Any, what: str) -> None:
    if not isinstance(price, dict) or "amount" not in price or "currency" not in price:
        raise _error(f"{what}: price needs an `amount` (major units) and a `currency`.")
    amount = price["amount"]
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount < 0:
        raise _error(f"{what}: price.amount must be a non-negative number.")
    if not isinstance(price["currency"], str) or _CURRENCY.fullmatch(price["currency"]) is None:
        raise _error(f"{what}: `currency` must be an ISO 4217 code such as XOF or EUR.")


# ── Features ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Feature:
    """A right, identified by its name. Call it to include it in a plan: ``export()`` or
    ``messages(limit=100, reset="month")``."""

    name: str
    type: Literal["boolean", "metered"]

    def __post_init__(self) -> None:
        _assert_name(self.name, "feature", 'feature("Messages", "metered")')

    def __call__(self, limit: int | None = None, reset: Reset | None = None) -> Inclusion:
        if self.type == "boolean":
            if limit is not None or reset is not None:
                raise _error(f'Feature "{self.name}" is boolean: include it with no argument, without a limit.')
            return {"feature": self.name}
        if limit is None or isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise _error(f'Feature "{self.name}" is metered: include it with a whole, non-negative limit.')
        if reset is not None and reset not in RESETS:
            raise _error(f'Feature "{self.name}": reset must be one of {", ".join(RESETS)}.')
        inclusion: Inclusion = {"feature": self.name, "limit": limit}
        if reset is not None:
            inclusion["reset"] = reset
        return inclusion


def feature(name: str, type: Literal["boolean", "metered"]) -> Feature:
    """``feature("Export", "boolean")`` (access) or ``feature("Messages", "metered")`` (a quota per period)."""
    if type not in ("boolean", "metered"):
        raise _error(f'Feature "{name}": type must be "boolean" or "metered".')
    return Feature(name, type)


# ── Subscriptions ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Group:
    """A subscription product, identified by its name: its plans exclude one another for a customer."""

    name: str
    description: str | None = None

    def __post_init__(self) -> None:
        _assert_name(self.name, "product", 'group("My App")')


def group(name: str, description: str | None = None) -> Group:
    return Group(name, description)


@dataclass(frozen=True)
class Plan:
    """A plan of a subscription product. Its ``name`` is its identity inside the product: Itaja
    assigns the system id, and renaming a plan creates a new one (the old one is archived)."""

    name: str
    group: Group
    description: str | None = None
    price: Price | None = None
    trial_days: int | None = None
    default: bool = False
    includes: tuple[Inclusion, ...] = field(default_factory=tuple)


def plan(
    name: str,
    group: Group | str,
    *,
    description: str | None = None,
    price: Price | None = None,
    trial_days: int | None = None,
    default: bool = False,
    includes: Sequence[Inclusion] = (),
) -> Plan:
    """A plan of a group (or of the group named ``group``), identified by its ``name`` (``"Pro"``).
    The group's ``default`` plan is its free fallback and may omit ``price``."""
    _assert_name(name, "plan", 'plan("Pro", app, ...)')
    g = group if isinstance(group, Group) else Group(group)
    if not default and price is None:
        raise _error(f'Plan "{name}" has no price: only the group\'s default plan may be free.')
    if price is not None:
        _assert_money(price, f'Plan "{name}"')
        if price.get("interval") not in INTERVALS:
            raise _error(f'Plan "{name}": price.interval must be one of {", ".join(INTERVALS)}.')
    return Plan(name, g, description, price, trial_days, default, tuple(includes))


# ── Credits ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Credits:
    """A credit currency your app spends as the buyer uses it, identified by its name. Sell it with
    ``credit_pack``."""

    name: str
    description: str | None = None
    #: What the buyer calls one credit (``Tokens``, ``Coins``). Defaults to the name.
    coin_name: str | None = None

    def __post_init__(self) -> None:
        _assert_name(self.name, "product", 'credits("AI tokens")')


def credits(name: str, *, description: str | None = None, coin_name: str | None = None) -> Credits:
    return Credits(name, description, coin_name)


@dataclass(frozen=True)
class CreditPack:
    """A bundle of credits. Its ``name`` is its identity inside its credits product and the label
    the buyer reads."""

    name: str
    of: Credits
    credits: int
    price: Money
    description: str | None = None


def credit_pack(name: str, of: Credits, credits: int, price: Money, *, description: str | None = None) -> CreditPack:
    """A bundle of credits sold at a fixed price, named as the buyer reads it (``"100 tokens"``)."""
    _assert_name(name, "credit pack", 'credit_pack("100 tokens", tokens, 100, price)')
    if isinstance(credits, bool) or not isinstance(credits, int) or credits < 1:
        raise _error(f'Credit pack "{name}": credits must be a whole number of at least 1.')
    _assert_money(price, f'Credit pack "{name}"')
    return CreditPack(name, of, credits, price, description)


# ── Licences ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class License:
    """A licence product, identified by its name."""

    name: str
    price: Money
    #: Devices one key unlocks; ``None`` = unlimited.
    devices: int | None
    duration: str | None = None
    description: str | None = None


def license(
    name: str,
    *,
    price: Money,
    devices: int | None,
    duration: str | None = None,
    description: str | None = None,
) -> License:
    """A licence key that unlocks your software. ``duration``: ``"lifetime"``, ``"days-N"``,
    ``"from-first-activation-days-N"``."""
    _assert_name(name, "product", 'license("Desktop app", price=..., devices=3)')
    _assert_money(price, f'License "{name}"')
    if duration is not None and _DURATION.fullmatch(duration) is None:
        raise _error(f'License "{name}": duration must be "lifetime", "days-N" or "from-first-activation-days-N".')
    return License(name, price, devices, duration, description)


# ── The catalogue ───────────────────────────────────────────────────────────

CatalogItem = Feature | Plan | Credits | CreditPack | License


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


@dataclass
class _Product:
    kind: Literal["group", "credits", "license"]
    decl: Group | Credits | License
    plans: list[Plan] = field(default_factory=list)
    packs: list[CreditPack] = field(default_factory=list)


def to_catalog_document(items: Iterable[CatalogItem]) -> dict[str, Any]:
    """Turns a declaration into the canonical catalogue. Deterministic: the same declaration gives
    the same JSON, in declaration order, in every language. Refuses locally what the API would
    refuse: two items of one scope whose names match once normalised, a plan including a feature
    the catalogue does not declare."""
    features: dict[str, Feature] = {}
    products: dict[str, _Product] = {}

    def product(kind: Literal["group", "credits", "license"], decl: Group | Credits | License) -> _Product:
        key = normalize_name(decl.name)
        known = products.get(key)
        if known is None:
            products[key] = _Product(kind, decl)
            return products[key]
        # The same product reached twice (a group shared by its plans, credits and their packs)
        # is one product; two declarations of one name are refused.
        if known.kind == kind and kind != "license" and known.decl == decl:
            return known
        raise _error(
            f'Product "{decl.name}" is declared twice (same name as "{known.decl.name}"): product names are '
            "unique across subscriptions, credits and licences, compared trimmed and case-insensitively."
        )

    for item in items:
        if isinstance(item, Feature):
            key = normalize_name(item.name)
            seen = features.get(key)
            if seen is not None and seen != item:
                raise _error(
                    f'Feature "{item.name}" is declared twice (same name as "{seen.name}": feature names are '
                    "compared trimmed and case-insensitively)."
                )
            features[key] = item
        elif isinstance(item, Plan):
            entry = product("group", item.group)
            twin = next((p for p in entry.plans if normalize_name(p.name) == normalize_name(item.name)), None)
            if twin is not None:
                raise _error(
                    f'Plan "{item.name}" is declared twice in group "{entry.decl.name}" (same name as '
                    f'"{twin.name}": plan names are compared trimmed and case-insensitively).'
                )
            if item.default and any(p.default for p in entry.plans):
                raise _error(f'Group "{entry.decl.name}" has two default plans; keep one.')
            entry.plans.append(item)
        elif isinstance(item, (Credits, CreditPack)):
            entry = product("credits", item if isinstance(item, Credits) else item.of)
            if isinstance(item, CreditPack):
                pack_twin = next((p for p in entry.packs if normalize_name(p.name) == normalize_name(item.name)), None)
                if pack_twin is not None:
                    raise _error(
                        f'Credit pack "{item.name}" is declared twice in "{entry.decl.name}" (same name as '
                        f'"{pack_twin.name}": pack names are compared trimmed and case-insensitively).'
                    )
                entry.packs.append(item)
        elif isinstance(item, License):
            product("license", item)
        else:
            raise _error("The catalogue accepts feature, plan, credits, credit_pack and license items only.")

    out: list[dict[str, Any]] = []
    for entry in products.values():
        decl = entry.decl
        if isinstance(decl, Group):
            for p in entry.plans:
                for inclusion in p.includes:
                    if normalize_name(inclusion["feature"]) not in features:
                        raise _error(
                            f'Plan "{p.name}" includes feature "{inclusion["feature"]}", which the catalogue '
                            "does not declare. Add the feature to the catalogue."
                        )
            out.append(
                _drop_none(
                    {
                        "type": "subscription",
                        "name": decl.name,
                        "description": decl.description,
                        "plans": [
                            _drop_none(
                                {
                                    "name": p.name,
                                    "description": p.description,
                                    "default": True if p.default else None,
                                    "trial": {"days": p.trial_days} if p.trial_days is not None else None,
                                    "price": dict(p.price) if p.price is not None else None,
                                    "includes": [dict(i) for i in p.includes],
                                }
                            )
                            for p in entry.plans
                        ],
                    }
                )
            )
        elif isinstance(decl, Credits):
            if not entry.packs:
                raise _error(f'Credits "{decl.name}" has no pack: declare at least one credit_pack for it.')
            out.append(
                _drop_none(
                    {
                        "type": "credits",
                        "name": decl.name,
                        "description": decl.description,
                        "coinName": decl.coin_name,
                        "packs": [
                            _drop_none(
                                {
                                    "name": p.name,
                                    "description": p.description,
                                    "credits": p.credits,
                                    "price": dict(p.price),
                                }
                            )
                            for p in entry.packs
                        ],
                    }
                )
            )
        else:
            document: dict[str, Any] = {"type": "license", "name": decl.name}
            if decl.description is not None:
                document["description"] = decl.description
            document["devices"] = decl.devices  # null means unlimited: always sent
            if decl.duration is not None:
                document["duration"] = decl.duration
            document["price"] = dict(decl.price)
            out.append(document)

    return {"features": [{"name": f.name, "type": f.type} for f in features.values()], "products": out}
