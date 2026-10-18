from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

SPEC = Path(__file__).resolve().parents[3] / "spec"


def spec_json(name: str) -> Any:
    return json.loads((SPEC / name).read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _no_itaja_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A test never reads the developer's own ITAJA_* variables by accident."""
    for name in ("ITAJA_API_KEY", "ITAJA_WEBHOOK_SECRET", "ITAJA_API_URL"):
        monkeypatch.delenv(name, raising=False)
