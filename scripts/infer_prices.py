#!/usr/bin/env python3
"""
Fetch 6 months of Cursor usage CSV, infer cost_per_token per model from
on-demand rows, and merge results into prices.json.

Existing entries in prices.json are never removed; new models are added and
existing ones are updated if the new fetch has more on-demand data for them.

Run periodically (e.g. weekly) by anyone with on-demand usage history.
"""
import csv
import json
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("Install requests: pip install requests", file=sys.stderr)
    sys.exit(1)

PRICES_PATH = Path(__file__).resolve().parent.parent / "prices.json"
DAYS = 180


def get_token() -> str:
    import json as _json
    import os
    import sqlite3
    from base64 import urlsafe_b64decode

    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        db_path = Path(base) / "Cursor" / "User" / "globalStorage" / "state.vscdb"
    elif sys.platform == "darwin":
        db_path = Path.home() / "Library" / "Application Support" / "Cursor" / "User" / "globalStorage" / "state.vscdb"
    else:
        db_path = Path.home() / ".config" / "Cursor" / "User" / "globalStorage" / "state.vscdb"

    if not db_path.exists():
        raise SystemExit(f"Cursor DB not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key = ?",
            ("cursorAuth/accessToken",),
        ).fetchone()
    finally:
        conn.close()

    if not row:
        raise SystemExit("cursorAuth/accessToken not found. Is Cursor logged in?")

    jwt = row[0]

    try:
        payload_b64 = jwt.split(".")[1]
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += "=" * padding
        claims = _json.loads(urlsafe_b64decode(payload_b64))
        sub = claims.get("sub", "")
        user_id = sub.split("|")[-1]
        return f"{user_id}%3A%3A{jwt}"
    except Exception as e:
        raise SystemExit(f"Failed to build session token: {e}")


def fetch_csv(token: str, days: int) -> list[dict]:
    now_ms = int(time.time() * 1000)
    start_ms = now_ms - days * 24 * 60 * 60 * 1000
    url = (
        f"https://cursor.com/api/dashboard/export-usage-events-csv"
        f"?startDate={start_ms}&endDate={now_ms}&strategy=tokens"
    )
    headers = {
        "Cookie": f"WorkosCursorSessionToken={token}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    r = requests.get(url, headers=headers)
    if not r.ok:
        raise SystemExit(f"API error {r.status_code}: {r.text[:500]}")
    lines = r.text.strip().splitlines()
    if not lines:
        return []
    return list(csv.DictReader(lines))


def infer_prices(rows: list[dict]) -> dict[str, dict]:
    """Return {model: {on_demand_cost, on_demand_tokens, cost_per_token}} for models with on-demand data."""
    stats: dict[str, dict] = {}
    for row in rows:
        model = (row.get("Model") or "").strip()
        kind = (row.get("Kind") or "").strip()
        cost_raw = (row.get("Cost") or "").strip()
        total_raw = (row.get("Total Tokens") or "0").strip()
        if not model or model.lower() == "auto":
            continue
        if kind != "On-Demand" or cost_raw in ("", "Included", "Errored, No Charge"):
            continue
        try:
            cost = float(cost_raw)
            total = int(total_raw) or 0
        except ValueError:
            continue
        if total <= 0 or cost <= 0:
            continue
        s = stats.setdefault(model, {"on_demand_cost": 0.0, "on_demand_tokens": 0})
        s["on_demand_cost"] += cost
        s["on_demand_tokens"] += total

    result = {}
    for model, s in stats.items():
        if s["on_demand_tokens"] > 0:
            result[model] = {
                "cost_per_token": s["on_demand_cost"] / s["on_demand_tokens"],
                "on_demand_cost": round(s["on_demand_cost"], 6),
                "on_demand_tokens": s["on_demand_tokens"],
            }
    return result


def load_prices() -> dict:
    if PRICES_PATH.exists():
        try:
            return json.loads(PRICES_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def merge_prices(existing: dict, inferred: dict) -> tuple[dict, list[str], list[str]]:
    merged = dict(existing)
    added = []
    updated = []
    for model, data in inferred.items():
        if model not in merged:
            merged[model] = data
            added.append(model)
        else:
            old_tokens = merged[model].get("on_demand_tokens", 0)
            new_tokens = data["on_demand_tokens"]
            if new_tokens > old_tokens:
                merged[model] = data
                updated.append(model)
    return merged, added, updated


def main() -> None:
    print(f"Fetching {DAYS} days of usage data...")
    token = get_token()
    rows = fetch_csv(token, DAYS)
    print(f"  Got {len(rows)} rows")

    inferred = infer_prices(rows)
    print(f"  Inferred prices for {len(inferred)} model(s) with on-demand data")

    existing = load_prices()
    print(f"  Existing prices.json has {len(existing)} model(s)")

    merged, added, updated = merge_prices(existing, inferred)

    PRICES_PATH.write_text(
        json.dumps(merged, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print(f"\nDone. prices.json now has {len(merged)} model(s)")
    if added:
        print(f"  Added:   {', '.join(added)}")
    if updated:
        print(f"  Updated: {', '.join(updated)}")
    if not added and not updated:
        print("  No changes (no new or better on-demand data found)")


if __name__ == "__main__":
    main()
