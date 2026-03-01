"""
cursor-pace: fetch last 30 days of Cursor usage and compute cost-per-token per model.

Usage:
    python fetch_usage.py

Auth token is auto-extracted from Cursor's local SQLite database.
Falls back to CURSOR_SESSION_TOKEN in .env if the DB is unavailable.
"""

import argparse
import base64
import csv
import io
import json
import os
import platform
import shutil
import sqlite3
import tempfile
import time
from collections import defaultdict

import requests


def get_db_path() -> str:
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("APPDATA", "")
    elif system == "Darwin":
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.path.expanduser("~/.config")
    return os.path.join(base, "Cursor", "User", "globalStorage", "state.vscdb")


def decode_jwt_sub(jwt_token: str) -> str | None:
    """Decode JWT payload without verification and return the 'sub' claim."""
    try:
        parts = jwt_token.split(".")
        if len(parts) != 3:
            return None
        payload = parts[1]
        # Add padding if needed
        payload += "=" * (4 - len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload)
        claims = json.loads(decoded)
        return claims.get("sub")
    except Exception:
        return None


def build_session_token(jwt_token: str) -> str | None:
    """Build WorkosCursorSessionToken from JWT: {userId}%3A%3A{jwt}"""
    sub = decode_jwt_sub(jwt_token)
    if not sub:
        return None
    # sub is like "google-oauth2|user_01JCN..." — take the part after |
    user_id = sub.split("|")[-1]
    return f"{user_id}%3A%3A{jwt_token}"


def extract_token_from_db() -> str | None:
    db_path = get_db_path()
    if not os.path.exists(db_path):
        return None
    # Copy to temp file so we don't conflict with Cursor's lock
    with tempfile.NamedTemporaryFile(suffix=".vscdb", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        shutil.copy2(db_path, tmp_path)
        conn = sqlite3.connect(tmp_path)
        cur = conn.execute(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1"
        )
        row = cur.fetchone()
        conn.close()
        if not row:
            return None
        jwt_token = row[0]
        return build_session_token(jwt_token)
    finally:
        os.unlink(tmp_path)


def resolve_token(override: str | None) -> str:
    if override:
        return override
    print("Auto-extracting token from Cursor's local database...")
    token = extract_token_from_db()
    if token:
        print("Token found.")
        return token
    raise SystemExit(
        "Could not find a session token. Make sure Cursor is installed and you're logged in."
    )


def fetch_csv(token: str, start_ms: int, end_ms: int) -> str:
    url = "https://cursor.com/api/dashboard/export-usage-events-csv"
    params = {"startDate": start_ms, "endDate": end_ms, "strategy": "tokens"}
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }
    resp = requests.get(
        url, params=params,
        cookies={"WorkosCursorSessionToken": token},
        headers=headers,
        timeout=30,
        allow_redirects=False,
    )
    if resp.status_code != 200:
        print(f"Auth failed (status {resp.status_code}). Response: {resp.text[:300]}")
    resp.raise_for_status()
    return resp.text


def parse_csv(raw: str) -> list[dict]:
    reader = csv.DictReader(io.StringIO(raw))
    return list(reader)


def analyse(rows: list[dict]) -> dict:
    # Per-model accumulators
    stats = defaultdict(lambda: {
        "total_tokens": 0,
        "input_tokens": 0,
        "cache_read_tokens": 0,
        "output_tokens": 0,
        "on_demand_cost": 0.0,
        "on_demand_tokens": 0,
        "included_tokens": 0,
        "requests": 0,
    })

    for row in rows:
        model = row["Model"].strip()
        kind = row["Kind"].strip()
        total = int(row["Total Tokens"] or 0)
        input_w_cache = int(row["Input (w/ Cache Write)"] or 0)
        input_wo_cache = int(row["Input (w/o Cache Write)"] or 0)
        cache_read = int(row["Cache Read"] or 0)
        output = int(row["Output Tokens"] or 0)
        cost_raw = row["Cost"].strip()

        s = stats[model]
        s["total_tokens"] += total
        s["input_tokens"] += input_w_cache + input_wo_cache
        s["cache_read_tokens"] += cache_read
        s["output_tokens"] += output
        s["requests"] += 1

        if kind == "On-Demand" and cost_raw not in ("Included", ""):
            try:
                cost = float(cost_raw)
                s["on_demand_cost"] += cost
                s["on_demand_tokens"] += total
            except ValueError:
                pass
        else:
            s["included_tokens"] += total

    return stats


def compute_cost_per_token(stats: dict) -> dict:
    result = {}
    for model, s in stats.items():
        if s["on_demand_tokens"] > 0:
            cpt = s["on_demand_cost"] / s["on_demand_tokens"]
        else:
            cpt = None  # no on-demand data to calibrate from

        # Estimate total cost (on-demand actual + included estimated)
        estimated_included_cost = (
            (s["included_tokens"] * cpt) if cpt is not None else None
        )
        total_estimated_cost = (
            s["on_demand_cost"] + estimated_included_cost
            if estimated_included_cost is not None
            else s["on_demand_cost"]
        )

        result[model] = {
            **s,
            "cost_per_token": cpt,
            "estimated_included_cost": estimated_included_cost,
            "total_estimated_cost": total_estimated_cost,
        }
    return result


def print_report(result: dict):
    print(f"\n{'='*90}")
    print(f"{'MODEL':<40} {'REQUESTS':>8} {'TOTAL TOKENS':>14} {'CPT ($/1M)':>12} {'EST. COST ($)':>13}")
    print(f"{'='*90}")

    # Sort by total estimated cost descending
    sorted_models = sorted(
        result.items(),
        key=lambda x: x[1]["total_estimated_cost"] or 0,
        reverse=True,
    )

    grand_total = 0.0
    for model, s in sorted_models:
        cpt_display = (
            f"{s['cost_per_token'] * 1_000_000:.4f}" if s["cost_per_token"] is not None else "no data"
        )
        cost_display = (
            f"{s['total_estimated_cost']:.4f}" if s["total_estimated_cost"] else "—"
        )
        print(
            f"{model:<40} {s['requests']:>8,} {s['total_tokens']:>14,} "
            f"{cpt_display:>12} {cost_display:>13}"
        )
        if s["total_estimated_cost"]:
            grand_total += s["total_estimated_cost"]

    print(f"{'='*90}")
    print(f"{'TOTAL ESTIMATED COST':>75} ${grand_total:>10.4f}")
    print()
    print("Note: 'CPT' is cost per token derived from On-Demand rows.")
    print("      Included-tier tokens are estimated using the same rate.")
    print("      Models with 'no data' had zero On-Demand usage in this period.")


def save_json(result: dict, path: str):
    serialisable = {
        model: {k: v for k, v in s.items()}
        for model, s in result.items()
    }
    with open(path, "w") as f:
        json.dump(serialisable, f, indent=2)
    print(f"Saved calibration data to {path}")


def main():
    parser = argparse.ArgumentParser(description="Cursor usage cost analyser")
    parser.add_argument("--token", default=None, help="Override session token (optional — auto-detected by default)")
    parser.add_argument("--days", type=int, default=30, help="How many days back to fetch (default: 30)")
    parser.add_argument("--save", default="cost_calibration.json", help="Output JSON path for calibration data")
    args = parser.parse_args()

    token = resolve_token(args.token)

    now_ms = int(time.time() * 1000)
    start_ms = now_ms - args.days * 24 * 60 * 60 * 1000

    print(f"Fetching last {args.days} days of usage...")
    raw = fetch_csv(token, start_ms, now_ms)

    rows = parse_csv(raw)
    print(f"Parsed {len(rows):,} usage events.")

    stats = analyse(rows)
    result = compute_cost_per_token(stats)

    print_report(result)
    save_json(result, args.save)


if __name__ == "__main__":
    main()
