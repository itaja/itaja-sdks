"""``create_itaja``: the one object a merchant's server holds.

.. code-block:: python

    itaja = create_itaja(
        api_key=os.environ["ITAJA_API_KEY"],
        webhook_secret=os.environ["ITAJA_WEBHOOK_SECRET"],
        catalog=[messages, free, pro],
        on={"checkout.paid": fulfil},
    )

Products and credit packs are referenced by their **name** (``product="AI tokens"``,
``pack="100 tokens"``), never by an id: the SDK resolves a name once against the products
your last ``push`` created, comparing it trimmed, inner whitespace collapsed and
case-insensitively.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, Literal
from urllib.parse import quote

import httpx

from ._transport import DEFAULT_BASE_URL, Method, Transport, mode_of_key
from .catalog import CatalogItem, normalize_name, to_catalog_document
from .errors import ItajaConfigError, ItajaError, ItajaNotFoundError
from .handler import DedupeStore, Handler, WebhookProcessor
from .webhooks import DEFAULT_TOLERANCE, Event


def _seg(value: str) -> str:
    return quote(value, safe="")


def _clean(values: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


class _Resource:
    def __init__(self, itaja: Itaja) -> None:
        self._itaja = itaja

    def _req(self, method: Method, path: str, **kwargs: Any) -> Any:
        return self._itaja.request(method, path, **kwargs)


class Customers(_Resource):
    def create(self, *, idempotency_key: str | None = None, **fields: Any) -> Any:
        """``name``, ``email``, ``phoneNumber``, ``address``, ``metadata``, ``merchantCustomerId``."""
        return self._req("POST", "/customers", body=fields, idempotency_key=idempotency_key)

    def get(self, customer_id: str) -> Any:
        """``customer_id`` is Itaja's id or **your** ``merchantCustomerId``."""
        return self._req("GET", f"/customers/{_seg(customer_id)}")

    def update(self, customer_id: str, *, idempotency_key: str | None = None, **fields: Any) -> Any:
        return self._req("PATCH", f"/customers/{_seg(customer_id)}", body=fields, idempotency_key=idempotency_key)

    def list(self, **query: Any) -> Any:
        return self._req("GET", "/customers", query=query)

    def invoices(self, customer_id: str) -> Any:
        return self._req("GET", f"/customers/{_seg(customer_id)}/invoices")


class Checkout(_Resource):
    def create(self, *, idempotency_key: str | None = None, **fields: Any) -> Any:
        """A cart you price yourself (``homeUrl``, ``currency``, ``lineItems``...). Returns the ``checkoutUrl``.

        ``successUrl``, ``failureUrl`` and ``cancelUrl`` (optional) are where Itaja's return page
        sends the payer for each outcome; confirm payment from the webhook, never from the redirect.
        """
        return self._req("POST", "/checkout-sessions", body=fields, idempotency_key=idempotency_key)


class Credits(_Resource):
    def _path(self, product: str) -> str:
        return f"/products/{_seg(self._itaja._product_id(product))}"

    def _move(self, kind: str, product: str, body: dict[str, Any], key: str | None) -> Any:
        # Credits take their own body `idempotencyKey`: the same as the header's, so a retry is one movement.
        key = key or str(uuid.uuid4())
        return self._req(
            "POST",
            f"{self._path(product)}/credits/{kind}",
            body={**body, "idempotencyKey": key},
            idempotency_key=key,
        )

    def grant(
        self,
        *,
        customer_id: str,
        amount: int,
        product: str,
        reason: str | None = None,
        expires_at: str | None = None,
        low_balance_threshold: int | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        body = _clean(
            {
                "customerId": customer_id,
                "amount": amount,
                "reason": reason,
                "expiresAt": expires_at,
                "lowBalanceThreshold": low_balance_threshold,
            }
        )
        return self._move("grant", product, body, idempotency_key)

    def consume(
        self,
        *,
        customer_id: str,
        amount: int,
        product: str,
        reason: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Refuses, writing nothing, when the balance is short."""
        body = _clean({"customerId": customer_id, "amount": amount, "reason": reason})
        return self._move("consume", product, body, idempotency_key)

    def balance(self, *, customer_id: str, product: str) -> Any:
        return self._req("GET", f"{self._path(product)}/credits/{_seg(customer_id)}/balance")

    def wallet(self, *, customer_id: str, product: str, limit: int | None = None) -> Any:
        return self._req("GET", f"{self._path(product)}/credits/{_seg(customer_id)}", query={"limit": limit})

    def wallet_token(self, *, customer_id: str, product: str) -> Any:
        """A 15-minute token the buyer's device spends with, without your key."""
        return self._req("POST", f"{self._path(product)}/credits/{_seg(customer_id)}/wallet-token")

    def packs(self, *, product: str) -> Any:
        return self._req("GET", f"{self._path(product)}/credit-packs")

    def buy(
        self,
        *,
        pack: str,
        customer_id: str,
        home_url: str,
        product: str,
        success_url: str | None = None,
        failure_url: str | None = None,
        cancel_url: str | None = None,
        reference: str | None = None,
        language: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Sells a declared pack, named as declared (``pack="100 tokens"``): returns the checkout to
        send the buyer to.

        ``success_url``, ``failure_url`` and ``cancel_url`` are optional, as on ``checkout.create``.
        """
        base = self._path(product)
        listed = self._req("GET", f"{base}/credit-packs")
        packs = listed.get("packs", []) if isinstance(listed, dict) else []
        wanted = normalize_name(pack) if isinstance(pack, str) else ""
        found = next(
            (
                p
                for p in packs
                if wanted and isinstance(p.get("catalogKey"), str) and normalize_name(p["catalogKey"]) == wanted
            ),
            None,
        )
        if found is None:
            raise ItajaNotFoundError(
                f'No credit pack named "{pack}" is on sale for "{product}".', code="CREDIT_PACK_NOT_FOUND", status=404
            )
        body = _clean(
            {
                "customerId": customer_id,
                "homeUrl": home_url,
                "successUrl": success_url,
                "failureUrl": failure_url,
                "cancelUrl": cancel_url,
                "reference": reference,
                "language": language,
            }
        )
        return self._req(
            "POST", f"{base}/credit-packs/{_seg(found['id'])}/checkout", body=body, idempotency_key=idempotency_key
        )


class Licenses(_Resource):
    def _path(self, product: str, key_id: str | None = None, tail: str = "") -> str:
        base = f"/products/{_seg(self._itaja._product_id(product))}/licenses"
        return base + (f"/{_seg(key_id)}" if key_id else "") + tail

    def issue(
        self,
        *,
        product: str,
        customer_id: str | None = None,
        activations_max: int | None = None,
        expires_at: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        body = _clean({"customerId": customer_id, "activationsMax": activations_max, "expiresAt": expires_at})
        return self._req("POST", self._path(product), body=body, idempotency_key=idempotency_key)

    def list(
        self,
        *,
        product: str,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> Any:
        return self._req("GET", self._path(product), query={"limit": limit, "cursor": cursor})

    def get(self, key_id: str, *, product: str) -> Any:
        return self._req("GET", self._path(product, key_id))

    def revoke(
        self,
        key_id: str,
        *,
        product: str,
        reason: str | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        return self._req(
            "POST",
            self._path(product, key_id, "/revoke"),
            body={"reason": reason},
            idempotency_key=idempotency_key,
        )

    def _action(self, key_id: str, action: str, product: str, key: str | None) -> Any:
        return self._req("POST", self._path(product, key_id, f"/{action}"), idempotency_key=key)

    def suspend(
        self,
        key_id: str,
        *,
        product: str,
        idempotency_key: str | None = None,
    ) -> Any:
        return self._action(key_id, "suspend", product, idempotency_key)

    def resume(
        self,
        key_id: str,
        *,
        product: str,
        idempotency_key: str | None = None,
    ) -> Any:
        return self._action(key_id, "resume", product, idempotency_key)

    def rotate(
        self,
        key_id: str,
        *,
        product: str,
        idempotency_key: str | None = None,
    ) -> Any:
        return self._action(key_id, "rotate", product, idempotency_key)

    def resend(
        self,
        key_id: str,
        *,
        product: str,
        idempotency_key: str | None = None,
    ) -> Any:
        return self._action(key_id, "resend", product, idempotency_key)


class Subscriptions(_Resource):
    def list(self, **query: Any) -> Any:
        return self._req("GET", "/subscriptions", query=query)

    def get(self, subscription_id: str) -> Any:
        return self._req("GET", f"/subscriptions/{_seg(subscription_id)}")

    def cancel(self, subscription_id: str, *, immediately: bool = False, idempotency_key: str | None = None) -> Any:
        """At period end, unless ``immediately``."""
        return self._req(
            "POST",
            f"/subscriptions/{_seg(subscription_id)}/cancel",
            body={"immediately": immediately},
            idempotency_key=idempotency_key,
        )

    def pause(self, subscription_id: str, *, idempotency_key: str | None = None) -> Any:
        return self._req("POST", f"/subscriptions/{_seg(subscription_id)}/pause", idempotency_key=idempotency_key)

    def resume(self, subscription_id: str, *, idempotency_key: str | None = None) -> Any:
        return self._req("POST", f"/subscriptions/{_seg(subscription_id)}/resume", idempotency_key=idempotency_key)


class Itaja:
    """Build it with :func:`create_itaja`."""

    def __init__(
        self,
        *,
        api_key: str,
        webhook_secret: str,
        base_url: str,
        catalog: Sequence[CatalogItem],
        on: Mapping[str, Handler],
        dedupe: DedupeStore | None,
        timeout: float,
        max_retries: int,
        tolerance: int,
        on_error: Callable[[BaseException, Event], None] | None,
        http: httpx.Client | None,
        sleep: Callable[[float], None] | None,
    ) -> None:
        self.api_key = api_key
        self.webhook_secret = webhook_secret
        self.base_url = base_url
        self._items = tuple(catalog)
        #: The canonical catalogue document ``push`` sends.
        self.catalog: dict[str, Any] = to_catalog_document(self._items)
        self._transport = Transport(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            http=http,
            **({"sleep": sleep} if sleep is not None else {}),
        )
        self.webhooks = WebhookProcessor(
            secret=webhook_secret, mode=self.mode, handlers=on, dedupe=dedupe, tolerance=tolerance, on_error=on_error
        )
        self._product_ids: dict[str, str] | None = None
        self.customers = Customers(self)
        self.checkout = Checkout(self)
        self.credits = Credits(self)
        self.licenses = Licenses(self)
        self.subscriptions = Subscriptions(self)

    def close(self) -> None:
        """Closes the HTTP connections. Optional: they are reused for the life of the process."""
        self._transport.close()

    def __enter__(self) -> Itaja:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @property
    def mode(self) -> Literal["sandbox", "live"]:
        """The API key's mode: ``sandbox`` (``itjs_``) or ``live`` (``itjp_``)."""
        return mode_of_key(self.api_key)

    def on(self, event_type: str) -> Callable[[Handler], Handler]:
        """Registers a handler: ``@itaja.on("checkout.paid")``. ``"*"`` receives every delivery."""

        def register(handler: Handler) -> Handler:
            self.webhooks.handlers[event_type] = handler
            return handler

        return register

    def push(self, *, dry_run: bool = False, idempotency_key: str | None = None) -> Any:
        """Syncs the catalogue. ``dry_run`` returns the diff without writing."""
        result = self.request(
            "PUT",
            "/catalog",
            query={"dryRun": "true"} if dry_run else None,
            body=self.catalog,
            idempotency_key=idempotency_key,
        )
        if not dry_run:
            self._product_ids = None  # a push may have created products
        return result

    def request(
        self,
        method: Method,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """The raw escape hatch: any developer-API route, envelope unwrapped, errors typed."""
        return self._transport.request(method, path, query=query, body=body, idempotency_key=idempotency_key)

    def subscribe(
        self,
        *,
        customer_id: str,
        plan: str,
        product: str | None = None,
        success_url: str | None = None,
        cancel_url: str | None = None,
    ) -> Any:
        """One call for new, upgrade, downgrade, cancel-to-free. ``plan`` is the plan's name as declared in
        the catalogue (``"Pro"``, case-insensitive); ``product`` (a subscription product's name) picks
        between products that sell a plan of that name. Not served by the API yet (itaja-services#465)."""
        raise self._not_yet("subscribe()", 465)

    def check(self, *, customer_id: str, feature: str) -> Any:
        """Is this customer entitled to a feature? Not served yet (#466)."""
        raise self._not_yet("check()", 466)

    def report(self, *, customer_id: str, feature: str, amount: int = 1) -> Any:
        """Count usage against a metered feature. Not served yet (#466)."""
        raise self._not_yet("report()", 466)

    def _product_id(self, product: str) -> str:
        """A product's name → its Itaja id, via the ``catalogKey`` (the normalised name) the push stored."""
        if not isinstance(product, str) or not product.strip():
            raise ItajaConfigError(
                'A product is referenced by its name: product="AI tokens".', code="PRODUCT_NAME_MISSING"
            )
        key = normalize_name(product)
        known = (self._product_ids if self._product_ids is not None else self._load_products()).get(key)
        if known is None:
            known = self._load_products().get(key)
        if known is not None:
            return known
        raise ItajaNotFoundError(
            f'No product named "{product}" in your {self.mode} Itaja catalogue. Run `itaja push` with this key first.',
            code="CATALOG_PRODUCT_NOT_PUSHED",
            status=404,
        )

    def _load_products(self) -> dict[str, str]:
        products = self.request("GET", "/products")
        self._product_ids = {
            normalize_name(p["catalogKey"]): p["id"]
            for p in (products if isinstance(products, list) else [])
            if isinstance(p, dict) and isinstance(p.get("catalogKey"), str) and isinstance(p.get("id"), str)
        }
        return self._product_ids

    @staticmethod
    def _not_yet(what: str, issue: int) -> ItajaError:
        return ItajaError(
            f"{what} is not served by the Itaja API yet (itaja/itaja-services#{issue}).", code="NOT_YET_AVAILABLE"
        )


def create_itaja(
    *,
    api_key: str | None = None,
    webhook_secret: str | None = None,
    base_url: str | None = None,
    catalog: Iterable[CatalogItem] = (),
    on: Mapping[str, Handler] | None = None,
    dedupe: DedupeStore | None = None,
    timeout: float = 30.0,
    max_retries: int = 2,
    tolerance: int = DEFAULT_TOLERANCE,
    on_error: Callable[[BaseException, Event], None] | None = None,
    http: httpx.Client | None = None,
    sleep: Callable[[float], None] | None = None,
) -> Itaja:
    """Builds the client. ``api_key``, ``webhook_secret`` and ``base_url`` default to the
    ``ITAJA_API_KEY``, ``ITAJA_WEBHOOK_SECRET`` and ``ITAJA_API_URL`` environment variables.

    Nothing is checked until it is used: a script that only prints the catalogue needs no key,
    and a missing key or secret raises :class:`ItajaConfigError` naming the variable."""
    return Itaja(
        api_key=api_key if api_key is not None else os.environ.get("ITAJA_API_KEY", ""),
        webhook_secret=webhook_secret if webhook_secret is not None else os.environ.get("ITAJA_WEBHOOK_SECRET", ""),
        base_url=base_url or os.environ.get("ITAJA_API_URL") or DEFAULT_BASE_URL,
        catalog=list(catalog),
        on=on or {},
        dedupe=dedupe,
        timeout=timeout,
        max_retries=max_retries,
        tolerance=tolerance,
        on_error=on_error,
        http=http,
        sleep=sleep,
    )
