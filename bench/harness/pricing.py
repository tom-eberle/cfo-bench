"""API-equivalent cost from token counts (prices.toml)."""

from __future__ import annotations

import tomllib
from functools import cache
from pathlib import Path

from .agents.base import Usage

PRICES_FILE = Path(__file__).with_name("prices.toml")


@cache
def load_prices() -> dict:
    return tomllib.loads(PRICES_FILE.read_text())


def price_entry(provider: str, model: str) -> dict | None:
    entry = load_prices().get(provider, {}).get(model)
    if not entry or entry.get("status") != "final":
        return None
    return entry


def cost_usd(provider: str, model: str, usage: Usage) -> float | None:
    """None when no final price is recorded (cost then stays unknown, never guessed).

    `usage.input_tokens` is uncached input (cache writes included, priced at the cache-write
    rate when reported), `cached_input_tokens` cache reads, `output_tokens` includes reasoning.
    Codex turns are priced per request with `cost_usd_requests` (long-context aware) when the
    rollout is available; this whole-turn form is the fallback."""
    p = price_entry(provider, model)
    if p is None:
        return None
    cache_write = usage.cache_write_tokens or 0
    return (
        (usage.input_tokens - cache_write) * p["input"]
        + cache_write * p.get("cache_write", p["input"])
        + usage.cached_input_tokens * p["cached_input"]
        + usage.output_tokens * p["output"]
    ) / 1_000_000


def cost_usd_requests(provider: str, model: str, requests: list[Usage]) -> float | None:
    """Sum over model requests; a request whose input exceeds `long_context_threshold` is priced
    at the long-context rates."""
    p = price_entry(provider, model)
    if p is None:
        return None
    total = 0.0
    for u in requests:
        n_in = u.input_tokens + u.cached_input_tokens
        long = p.get("long_context_threshold") and n_in > p["long_context_threshold"]
        q = {k: p.get(f"long_{k}", p.get(k)) for k in ("input", "cached_input", "cache_write", "output")} if long else p
        cw = u.cache_write_tokens or 0
        total += (
            (u.input_tokens - cw) * q["input"]
            + cw * q.get("cache_write", q["input"])
            + u.cached_input_tokens * q["cached_input"]
            + u.output_tokens * q["output"]
        ) / 1_000_000
    return total
