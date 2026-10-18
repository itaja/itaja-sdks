"""``itaja`` — the command line of the Python SDK.

    itaja catalog                     print the canonical catalogue your config declares
    itaja push [--dry-run] [--yes]    sync it to Itaja (asks before writing, unless --yes)
    itaja status                      dry-run; exits 1 when Itaja differs from your code
    itaja trigger <type> --url <url>  send a signed sample event to your local route

``--config module:attribute`` points at your client (default: ``itaja_config:itaja``, the
``itaja`` object of ``itaja_config.py`` in the current directory). The key and secret come
from that client, which usually reads ``ITAJA_API_KEY`` / ``ITAJA_WEBHOOK_SECRET``. The CLI
loads ``.env.local`` then ``.env`` first, never overriding a variable already set.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from .client import Itaja
from .errors import ItajaError
from .webhooks import EVENT_TYPES, sign_payload

ENV_FILES = (".env.local", ".env")


def load_env_files(directory: Path | None = None) -> None:
    """``KEY=value`` lines; ``#`` comments; optional quotes. A variable already set wins."""
    base = directory or Path.cwd()
    for name in ENV_FILES:
        path = base / name
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.removeprefix("export ").partition("=")
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            elif " #" in value:
                value = value.split(" #", 1)[0].rstrip()
            os.environ.setdefault(key, value)


def load_client(target: str) -> Itaja:
    sys.path.insert(0, str(Path.cwd()))
    module_name, _, attribute = target.partition(":")
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as error:
        if error.name == module_name:
            raise SystemExit(
                f"No {module_name}.py here. Create it with `itaja = create_itaja(...)`, "
                "or pass --config module:attribute."
            ) from None
        raise
    client = getattr(module, attribute or "itaja", None)
    if not isinstance(client, Itaja):
        raise SystemExit(f"{module_name}.{attribute or 'itaja'} must be the object create_itaja(...) returned.")
    return client


def _summary(diff: dict[str, Any]) -> dict[str, int]:
    summary = diff.get("summary") or {}
    return {k: int(summary.get(k) or 0) for k in ("created", "changed", "archived", "unchanged")}


def _changes(diff: dict[str, Any]) -> int:
    s = _summary(diff)
    return s["created"] + s["changed"] + s["archived"]


def _print_diff(diff: dict[str, Any]) -> None:
    marks = {"created": "+", "changed": "~", "archived": "-"}
    for change in diff.get("changes") or []:
        if change.get("action") == "unchanged":
            continue
        where = f"{change['product']}/" if change.get("product") else ""
        version = f" v{change['version']}" if change.get("version") is not None else ""
        fields = f" ({', '.join(change['fields'])})" if change.get("fields") else ""
        mark = marks.get(change.get("action", ""), "?")
        print(f"  {mark} {change.get('kind')} {where}{change.get('key')}{version}{fields}")
    s = _summary(diff)
    print(
        f"\n  {s['created']} created · {s['changed']} changed · {s['archived']} archived · {s['unchanged']} unchanged"
    )


def _sample(event_type: str) -> dict[str, Any] | None:
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    invoice = {
        "productId": "prd_sample",
        "contractId": "sub_sample",
        "customerId": "cus_sample",
        "planId": "pln_sample",
        "invoiceId": "inv_sample",
        "invoiceNumber": 1,
        "amount": 5000,
        "currency": "XOF",
        "periodStart": now,
        "periodEnd": now,
        "dueDate": now,
    }
    samples: dict[str, dict[str, Any]] = {
        "checkout.paid": {
            "checkoutId": "chk_sample",
            "productId": None,
            "transactionId": "txn_sample",
            "amount": 5000,
            "currency": "XOF",
            "paidAt": now,
        },
        "credits.granted": {
            "productId": "prd_sample",
            "walletId": "cwl_sample",
            "customerId": "cus_sample",
            "amount": 100,
            "delta": 100,
            "balanceAfter": 100,
            "reason": None,
            "idempotencyKey": "sample-grant",
        },
        "credits.low": {
            "productId": "prd_sample",
            "walletId": "cwl_sample",
            "customerId": "cus_sample",
            "balance": 10,
            "threshold": 20,
            "idempotencyKey": "sample-consume",
        },
        "license.issued": {
            "productId": "prd_sample",
            "keyId": "key_sample",
            "key": "ITJ-••••-••••-SMPL",
            "customerId": "cus_sample",
            "checkoutId": None,
            "activationsMax": 3,
            "expiresAt": None,
            "status": "ACTIVE",
        },
        "invoice.paid": {**invoice, "paidAt": now},
        "subscription.canceled": {
            "productId": "prd_sample",
            "contractId": "sub_sample",
            "customerId": "cus_sample",
            "planId": "pln_sample",
            "status": "CANCELED",
            "reason": "merchant",
            "collectionMode": "MANUAL",
            "currentPeriodStart": now,
            "currentPeriodEnd": now,
            "canceledAt": now,
            "endedAt": None,
        },
    }
    return samples.get(event_type)


def main(argv: list[str] | None = None) -> int:
    load_env_files()
    parser = argparse.ArgumentParser(prog="itaja", description="Itaja SDK command line. Reads .env and .env.local.")
    parser.add_argument(
        "--config", default="itaja_config:itaja", help="module:attribute of your create_itaja(...) client"
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("catalog", help="print the catalogue your config declares")
    push = commands.add_parser("push", help="sync the catalogue to Itaja")
    push.add_argument("--dry-run", action="store_true")
    push.add_argument("--yes", action="store_true", help="apply without asking (CI, deploy pipeline)")
    commands.add_parser("status", help="exit 1 when Itaja differs from your code")
    trigger = commands.add_parser("trigger", help="send a signed sample event to your route")
    trigger.add_argument("type", choices=EVENT_TYPES, metavar="type")
    trigger.add_argument("--url", required=True)
    trigger.add_argument("--data", help="the event data as JSON")
    trigger.add_argument("--mode", choices=("sandbox", "live"), default="sandbox")
    args = parser.parse_args(argv)

    try:
        if args.command == "trigger":
            secret = os.environ.get("ITAJA_WEBHOOK_SECRET", "")
            if not secret:
                print("Set ITAJA_WEBHOOK_SECRET (in .env) to the secret your route checks.", file=sys.stderr)
                return 1
            data = json.loads(args.data) if args.data else _sample(args.type)
            if not isinstance(data, dict):
                print(f"No sample for \"{args.type}\": pass --data '{{...}}'.", file=sys.stderr)
                return 1
            payload = json.dumps(
                {
                    "id": f"itaja_evt_trigger_{uuid.uuid4()}",
                    "type": args.type,
                    "apiVersion": "v1",
                    "mode": args.mode,
                    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                    "data": data,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            response = httpx.post(
                args.url,
                content=payload.encode(),
                headers={"content-type": "application/json", **sign_payload(payload, secret)},
            )
            print(f"{args.type} → {args.url}: HTTP {response.status_code} {response.text}")
            return 0 if response.is_success else 1

        # The merchant's client, not ours: it may be imported again in this process, so it stays open.
        return _sync(load_client(args.config), args)
    except ItajaError as error:
        print(f"Itaja error {error.status} {error.code}: {error.message}", file=sys.stderr)
        for issue in (error.details or {}).get("issues", []) or []:
            print(f"  - {issue.get('path')}: {issue.get('message')}", file=sys.stderr)
        return 1


def _sync(itaja: Itaja, args: argparse.Namespace) -> int:
    if args.command == "catalog":
        print(json.dumps(itaja.catalog, indent=2, ensure_ascii=False))
        return 0

    banner = f"Itaja {itaja.mode.upper()} catalogue"
    diff = itaja.push(dry_run=True)
    changed = _changes(diff)
    if args.command == "status" or args.dry_run:
        if args.json:
            print(json.dumps(diff, indent=2))
        else:
            print(f"{banner} — {'differs from your code' if changed else 'in sync'}:\n")
            _print_diff(diff)
        return 1 if args.command == "status" and changed else 0
    if not changed:
        print(json.dumps(diff, indent=2) if args.json else f"{banner} is already in sync. Nothing to push.")
        return 0
    if not args.json:
        print(f"{banner} — changes to apply:\n")
        _print_diff(diff)
        print()
    if not args.yes:
        if not sys.stdin.isatty():
            print("Not a terminal: pass --yes to apply.", file=sys.stderr)
            return 1
        if input(f"Apply these changes to your {itaja.mode} catalogue? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Aborted.", file=sys.stderr)
            return 1
    applied = itaja.push(idempotency_key=str(uuid.uuid4()))
    s = _summary(applied)
    if args.json:
        print(json.dumps(applied, indent=2))
    else:
        print(f"Pushed: {s['created']} created · {s['changed']} changed · {s['archived']} archived.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
