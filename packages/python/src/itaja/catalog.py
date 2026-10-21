"""The catalogue in code: one builder per way of selling, and ``to_catalog_document``
that turns what you declared into the canonical JSON ``PUT /v1/catalog`` takes
(``spec/catalog.schema.json``).

Every id is **yours** (``"app"``, ``"messages"``, ``"small"``). Plans have no id: a plan is
identified by its **name** inside its product (``"Pro"``), compared case-insensitively. Amounts are in
**major units** of their currency, as on every product route of the API
(``5000`` XOF, ``9.99`` EUR).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from .errors import ItajaConfigError

Interval = Literal["week", "month", "quarter", "year"]
Reset = Literal["day", "week", "month", "year"]

INTERVALS: tuple[str, ...] = ("week", "month", "quarter", "year")
RESETS: tuple[str, ...] = ("day", "week", "month", "year")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
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
    feature: str
    limit: int
    reset: Reset


def _error(message: str) -> ItajaConfigError:
    return ItajaConfigError(message, code="CATALOG_DECLARATION_INVALID")


def _assert_id(value: str, what: str) -> None:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise _error(
            f'Invalid {what} id "{value}": 1 to 64 letters, digits, "_" or "-", starting with a letter or a digit.'
        )


def _assert_money(price: Any, what: str) -> None:
    if not isinstance(price, dict) or "amount" not in price or "currency" not in price:
        raise _error(f"{what}: price needs an `amount` (major units) and a `currency`.")
    amount = price["amount"]
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount < 0:
        raise _error(f"{what}: price.amount must be a non-negative number.")
    if not isinstance(price["currency"], str) or _CURRENCY.fullmatch(price["currency"]) is None:
        raise _error(f"{what}: `currency` must be an ISO 4217 code such as XOF or EUR.")


def _humanize(value: str) -> str:
    words = re.sub(r"[_-]+", " ", value).strip()
    return words[:1].upper() + words[1:]


# ── Features ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Feature:
    """A right. Call it to include it in a plan: ``export()`` or ``messages(limit=100, reset="month")``."""

    id: str
    type: Literal["boolean", "metered"]

    def __post_init__(self) -> None:
        _assert_id(self.id, "feature")

    def __call__(self, limit: int | None = None, reset: Reset | None = None) -> Inclusion:
        if self.type == "boolean":
            if limit is not None or reset is not None:
                raise _error(f'Feature "{self.id}" is boolean: include it as {self.id}(), without a limit.')
            return {"feature": self.id}
        if limit is None or isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise _error(f'Feature "{self.id}" is metered: include it with a whole, non-negative limit.')
        if reset is not None and reset not in RESETS:
            raise _error(f'Feature "{self.id}": reset must be one of {", ".join(RESETS)}.')
        inclusion: Inclusion = {"feature": self.id, "limit": limit}
        if reset is not None:
            inclusion["reset"] = reset
        return inclusion


def feature(id: str, type: Literal["boolean", "metered"]) -> Feature:
    """``feature("export", "boolean")`` (access) or ``feature("messages", "metered")`` (a quota per period)."""
    if type not in ("boolean", "metered"):
        raise _error(f'Feature "{id}": type must be "boolean" or "metered".')
    return Feature(id, type)


# ── Subscriptions ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Group:
    """A subscription product: its plans exclude one another for a customer."""

    id: str
    name: str
    description: str | None = None

    def __post_init__(self) -> None:
        _assert_id(self.id, "group")


def group(id: str, name: str, description: str | None = None) -> Group:
    return Group(id, name, description)


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


_PLAN_NAME_MAX = 200


def _plan_key(name: str) -> str:
    """How Itaja compares plan names: trimmed, inner whitespace collapsed, case-insensitive."""
    return " ".join(name.split()).casefold()


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
    """A plan of a group, identified by its ``name`` (``"Pro"``). The group's ``default`` plan is
    its free fallback and may omit ``price``."""
    if not isinstance(name, str) or not name.strip():
        raise _error("A plan needs a name: it is the plan's identity inside its product.")
    name = name.strip()
    if len(name) > _PLAN_NAME_MAX:
        raise _error(f'Plan "{name[:40]}...": a plan name is at most {_PLAN_NAME_MAX} characters.')
    g = group if isinstance(group, Group) else Group(group, _humanize(group))
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
    """A credit currency your app spends as the buyer uses it. Sell it with ``credit_pack``."""

    id: str
    name: str
    description: str | None = None
    #: What the buyer calls one credit (``Tokens``, ``Coins``).
    coin_name: str | None = None

    def __post_init__(self) -> None:
        _assert_id(self.id, "credits")


def credits(id: str, name: str, *, description: str | None = None, coin_name: str | None = None) -> Credits:
    return Credits(id, name, description, coin_name)


@dataclass(frozen=True)
class CreditPack:
    id: str
    of: Credits
    credits: int
    price: Money
    label: str
    description: str | None = None


def credit_pack(
    id: str, of: Credits, credits: int, price: Money, *, label: str | None = None, description: str | None = None
) -> CreditPack:
    """A bundle of credits sold at a fixed price."""
    _assert_id(id, "credit pack")
    if isinstance(credits, bool) or not isinstance(credits, int) or credits < 1:
        raise _error(f'Credit pack "{id}": credits must be a whole number of at least 1.')
    _assert_money(price, f'Credit pack "{id}"')
    return CreditPack(id, of, credits, price, label or f"{credits} {of.coin_name or of.name}", description)


# ── Licences ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class License:
    id: str
    name: str
    price: Money
    #: Devices one key unlocks; ``None`` = unlimited.
    devices: int | None
    duration: str | None = None
    description: str | None = None


def license(
    id: str,
    name: str,
    *,
    price: Money,
    devices: int | None,
    duration: str | None = None,
    description: str | None = None,
) -> License:
    """A licence key that unlocks your software. ``duration``: ``"lifetime"``, ``"days-N"``,
    ``"from-first-activation-days-N"``."""
    _assert_id(id, "license")
    _assert_money(price, f'License "{id}"')
    if duration is not None and _DURATION.fullmatch(duration) is None:
        raise _error(f'License "{id}": duration must be "lifetime", "days-N" or "from-first-activation-days-N".')
    return License(id, name, price, devices, duration, description)


# ── The catalogue ───────────────────────────────────────────────────────────

CatalogItem = Feature | Plan | Credits | CreditPack | License


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def to_catalog_document(items: Iterable[CatalogItem]) -> dict[str, Any]:
    """Turns a declaration into the canonical catalogue. Deterministic: the same declaration gives
    the same JSON, in declaration order, in every language. Features are the ones you list."""
    features: dict[str, dict[str, str]] = {}
    groups: dict[str, tuple[Group, list[Plan]]] = {}
    credit_products: dict[str, tuple[Credits, list[CreditPack]]] = {}
    licenses: dict[str, License] = {}
    order: list[tuple[str, str]] = []

    def taken(product_id: str) -> bool:
        return product_id in groups or product_id in credit_products or product_id in licenses

    def duplicate(product_id: str) -> ItajaConfigError:
        return _error(
            f'Product id "{product_id}" is used twice in the catalogue '
            "(groups, credits and licences share one id space)."
        )

    for item in items:
        if isinstance(item, Feature):
            known = features.get(item.id)
            if known is not None and known["type"] != item.type:
                raise _error(f'Feature "{item.id}" is declared twice with different types.')
            features[item.id] = {"id": item.id, "type": item.type}
        elif isinstance(item, Plan):
            gid = item.group.id
            if gid not in groups:
                if taken(gid):
                    raise duplicate(gid)
                groups[gid] = (item.group, [])
                order.append(("group", gid))
            elif groups[gid][0].name != item.group.name:
                raise _error(f'Group "{gid}" is declared with two different names.')
            plans = groups[gid][1]
            same = next((p for p in plans if _plan_key(p.name) == _plan_key(item.name)), None)
            if same is not None:
                raise _error(
                    f'Plan "{item.name}" is declared twice in group "{gid}" (as "{same.name}"): plan names '
                    "are compared case-insensitively, ignoring extra whitespace."
                )
            if item.default and any(p.default for p in plans):
                raise _error(f'Group "{gid}" has two default plans; keep one.')
            plans.append(item)
        elif isinstance(item, (Credits, CreditPack)):
            currency = item if isinstance(item, Credits) else item.of
            if currency.id not in credit_products:
                if taken(currency.id):
                    raise duplicate(currency.id)
                credit_products[currency.id] = (currency, [])
                order.append(("credits", currency.id))
            if isinstance(item, CreditPack):
                packs = credit_products[currency.id][1]
                if any(p.id == item.id for p in packs):
                    raise _error(f'Credit pack "{item.id}" is declared twice in "{currency.id}".')
                packs.append(item)
        elif isinstance(item, License):
            if taken(item.id):
                raise duplicate(item.id)
            licenses[item.id] = item
            order.append(("license", item.id))
        else:
            raise _error("The catalogue accepts feature, plan, credits, credit_pack and license items only.")

    products: list[dict[str, Any]] = []
    for kind, product_id in order:
        if kind == "group":
            g, plans = groups[product_id]
            for p in plans:
                for inclusion in p.includes:
                    if inclusion["feature"] not in features:
                        raise _error(
                            f'Plan "{p.name}" includes feature "{inclusion["feature"]}", which the catalogue '
                            "does not declare. Add the feature to the catalogue."
                        )
            products.append(
                _drop_none(
                    {
                        "id": g.id,
                        "type": "subscription",
                        "name": g.name,
                        "description": g.description,
                        "plans": [
                            _drop_none(
                                {
                                    "name": p.name,
                                    "description": p.description,
                                    "price": dict(p.price) if p.price is not None else None,
                                    "trial": {"days": p.trial_days} if p.trial_days is not None else None,
                                    "default": True if p.default else None,
                                    "includes": [dict(i) for i in p.includes],
                                }
                            )
                            for p in plans
                        ],
                    }
                )
            )
        elif kind == "credits":
            c, packs = credit_products[product_id]
            if not packs:
                raise _error(f'Credits "{c.id}" has no pack: declare at least one credit_pack for it.')
            products.append(
                _drop_none(
                    {
                        "id": c.id,
                        "type": "credits",
                        "name": c.name,
                        "description": c.description,
                        "coinName": c.coin_name,
                        "packs": [
                            _drop_none(
                                {
                                    "id": p.id,
                                    "label": p.label,
                                    "description": p.description,
                                    "credits": p.credits,
                                    "price": dict(p.price),
                                }
                            )
                            for p in packs
                        ],
                    }
                )
            )
        else:
            lic = licenses[product_id]
            document = _drop_none(
                {
                    "id": lic.id,
                    "name": lic.name,
                    "description": lic.description,
                    "price": dict(lic.price),
                    "duration": lic.duration,
                    "type": "license",
                }
            )
            document["devices"] = lic.devices  # null means unlimited: always sent
            products.append(document)

    return {"features": list(features.values()), "products": products}
