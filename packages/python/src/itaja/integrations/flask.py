"""Flask: ``app.register_blueprint(webhook_blueprint(itaja))`` mounts ``POST /itaja/webhook``.

It reads ``request.get_data()``, the raw bytes, so the signature is checked on the
exact body Itaja sent.
"""

from __future__ import annotations

from flask import Blueprint, Response, jsonify, request

from ..client import Itaja


def webhook_blueprint(itaja: Itaja, path: str = "/itaja/webhook", name: str = "itaja") -> Blueprint:
    blueprint = Blueprint(name, __name__)

    @blueprint.post(path)
    def webhook() -> tuple[Response, int]:
        result = itaja.webhooks.process(request.get_data(), dict(request.headers))
        return jsonify(result.body), result.status

    return blueprint
