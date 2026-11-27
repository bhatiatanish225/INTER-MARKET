"""Published Treasury curves and fixed-contract QuantHub gold observations."""

import csv
import io
import math
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from hourly_history import CACHE, read_cache, today_utc, utc_stamp, write_cache

TREASURY = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv"
GOLD_CODES = {"GCZ26", "GCG27"}
treasury_lock = threading.Lock()


def treasury_csv(year):
    query = urlencode({"type": "daily_treasury_yield_curve", "field_tdr_date_value": year, "_format": "csv"})
    url = f"{TREASURY}/{year}/all?{query}"
    # Windows PowerShell uses the workstation's HTTP configuration for the public Treasury feed.
    shell = (shutil.which("pwsh") or shutil.which("powershell")) if os.name == "nt" else None
    if shell:
        result = subprocess.run(
            [shell, "-NoProfile", "-NonInteractive", "-Command",
             "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
             "(Invoke-WebRequest -UseBasicParsing -Uri $env:INTERMARKET_TREASURY_URL -TimeoutSec 8).Content"],
            env={**os.environ, "INTERMARKET_TREASURY_URL": url}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            check=True, timeout=11, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return result.stdout.decode("utf-8-sig")
    request = Request(url, headers={"Accept": "text/csv"})
    with urlopen(request, timeout=8) as response:
        return response.read(300_000).decode("utf-8-sig")


def treasury_closes(today):
    path = CACHE / "signals-treasury.json.gz"
    with treasury_lock:
        cached, saved = read_cache(path)
        if cached and time.time() - saved < 1800:
            return cached, None
        start = today - timedelta(days=400)
        rows = {}
        try:
            for year in range(start.year, today.year + 1):
                payload = treasury_csv(year)
                for row in csv.DictReader(io.StringIO(payload)):
                    try:
                        day = datetime.strptime(row["Date"], "%m/%d/%Y").date()
                        rates = [float(row[f"{tenor} Yr"]) for tenor in (2, 5, 10, 30)]
                    except (KeyError, TypeError, ValueError):
                        continue
                    if start <= day <= today and all(map(math.isfinite, rates)):
                        rows[utc_stamp(day) // 86400] = rates
            if not rows:
                raise ValueError("No published Treasury observations.")
        except (OSError, ValueError, subprocess.SubprocessError):
            return cached or [], "Treasury daily yields could not be refreshed."
        data = sorted(rows.items())
        try:
            write_cache(path, data)
        except OSError:
            pass
        return data, None


def market_context(history, gold):
    if gold not in GOLD_CODES:
        raise ValueError("Choose an available COMEX gold contract.")
    today = today_utc()
    first = today - timedelta(days=365)
    until = today + timedelta(days=1)
    treasury, treasury_warning = treasury_closes(today)
    daily, daily_warning = history.cached_bars(f"signals-gold-1D-{today}-{gold}", {gold}, first, until, "1D")
    intraday, intraday_warning = history.cached_bars(
        f"signals-gold-5M-{today}-{gold}", {gold}, today - timedelta(days=1), until, "5M")
    day_ms = 86_400_000
    today_ms = utc_stamp(today) * 1000
    now = int(time.time() * 1000)
    return {
        "treasury": treasury,
        "gold": {"code": gold, "closes": [[bar[0] // day_ms, bar[4]] for bar in daily.get(gold, ()) if bar[0] < today_ms],
                 "intraday": [[bar[0], bar[4]] for bar in intraday.get(gold, ()) if bar[0] + 300_000 <= now][-100:]},
        "warnings": [warning for warning in (treasury_warning, daily_warning, intraday_warning) if warning],
    }
