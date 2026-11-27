"""Cache and serve QuantHub's listed hourly calendar packages."""

import gzip
import json
import math
import threading
import time
from datetime import date, datetime, timedelta, timezone
from itertools import groupby, product
from uuid import uuid4

from refresh_history import DEFAULT_ENV_FILE, ROOT, QuantHub

MARKETS = {"SR3": "SRA", "I": "ER", "SO3": "SON"}
FAMILIES = {"spread": 2, "fly": 3}
TENORS = (3, 6, 12)
GENERICS = (1, 2, 3)
MONTH_CODES = "FGHJKMNQUVXZ"
FIRST_DAY = date(2021, 1, 1)
HOUR = 3600
CACHE = ROOT / ".hourly-history"


def utc_stamp(day):
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())


def month_index(day):
    return day.year * 12 + day.month - 1


def month_day(month):
    year, offset = divmod(month, 12)
    return date(year, offset + 1, 1)


def package_code(market, family, tenor, delivery):
    legs = []
    for offset in range(1 if family == "out" else FAMILIES[family]):
        year, month = divmod(delivery + offset * tenor, 12)
        legs.append(f"{MONTH_CODES[month]}{year % 100:02d}")
    return MARKETS[market] + "-".join(legs)


def generic_delivery(front, generic):
    return front + (generic - 1) * 3


def windows(start, end):
    if start >= end:
        return
    # The front delivery advances on Mar 1, Jun 1, Sep 1 and Dec 1 UTC.
    month = month_index(start)
    delivery = month + (2 - month) % 3
    if delivery == month:
        delivery += 3
    while max(FIRST_DAY, month_day(delivery - 3)) < end:
        yield delivery, max(FIRST_DAY, month_day(delivery - 3)), month_day(delivery)
        delivery += 3


def listed_spread_ranks(catalogue, market, tenor, today):
    front = next(windows(today, today + timedelta(days=1)))[0]
    return {
        1 + (item["start"] - front) // 3
        for item in catalogue
        if item["market"] == market and item["family"] == "spread" and item["tenor"] == tenor
        and item["start"] >= front and (item["start"] - front) % 3 == 0
    }


def read_cache(path):
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return json.load(handle), path.stat().st_mtime
    except (OSError, ValueError, EOFError):
        return None, 0


def write_cache(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{uuid4().hex}.tmp")
    try:
        with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=3) as handle:
            json.dump(data, handle, separators=(",", ":"))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class HourlyHistory:
    def __init__(self):
        self.client = None
        self.fetch_lock = threading.Lock()

    def fetch(self, codes, start, end, interval="1H"):
        if self.client is None:
            self.client = QuantHub(DEFAULT_ENV_FILE)
        return self.client.get("ohlc/", {
            "instruments": ",".join(sorted(codes)), "interval": interval, "start": start, "end": end - 1,
        }, protected=True)

    def block(self, delivery, first, last, fixed_code=None, *, generic=1):
        group = "rolling" if generic == 1 else "rolling-g2-g3"
        ranks = (1,) if generic == 1 else (2, 3)
        codes = {fixed_code} if fixed_code else {
            package_code(market, family, tenor, generic_delivery(delivery, rank))
            for market, family, tenor, rank in product(MARKETS, FAMILIES, TENORS, ranks)
        }
        return self.cached_bars(f"{delivery}-{fixed_code or group}", codes, first, last)

    def cached_bars(self, key, codes, first, last, interval="1H", *, shared=False):
        start = utc_stamp(first)
        stop = utc_stamp(last)
        now = int(time.time())
        end = min(stop, (now // HOUR + 1) * HOUR)
        paths = ({CACHE / f"{key}-{code}.json.gz": {code} for code in codes}
                 if shared else {CACHE / f"{key}.json.gz": codes})

        def lookup():
            ttl = 300 if now < stop + HOUR else 3600
            cached, missing = {}, set()
            for path, group in paths.items():
                data, saved = read_cache(path)
                available = data or {}
                cached.update(available)
                if saved >= stop + HOUR or now - saved < ttl:
                    missing.update(group.difference(available))
                else:
                    missing.update(group)
            return cached, missing

        cached, missing = lookup()
        if not missing:
            return cached, None
        with self.fetch_lock:
            cached, missing = lookup()
            if not missing:
                return cached, None
            try:
                rows = self.fetch(missing, start, end, interval)
            except RuntimeError as error:
                return cached, str(error)
            bars = {code: {} for code in missing}
            for row in rows:
                code, stamp = row.get("product"), row.get("time")
                if code not in bars or type(stamp) is not int or not start * 1000 <= stamp < end * 1000:
                    continue
                prices = [row.get(key) for key in ("open", "high", "low", "close")]
                volume = row.get("volume")
                if not all(type(price) in (int, float) and math.isfinite(price) for price in prices):
                    continue
                opening, high, low, close = prices
                if not low <= min(opening, close) <= max(opening, close) <= high:
                    continue
                if type(volume) not in (int, float) or not math.isfinite(volume) or volume <= 0:
                    continue
                multiplier = 100 if "-" in code and not code.startswith("SRA") else 1
                bar = [stamp, *[round(price * multiplier, 8) for price in prices], volume]
                if stamp in bars[code] and bars[code][stamp] != bar:
                    return cached, "QuantHub returned conflicting candles for the same interval."
                bars[code][stamp] = bar
            cached.update({code: [series[stamp] for stamp in sorted(series)] for code, series in bars.items()})
            try:
                for path, group in paths.items():
                    if not missing.isdisjoint(group):
                        write_cache(path, {code: cached[code] for code in group})
            except OSError:
                return cached, "QuantHub candles could not be saved to the local cache."
            return cached, None

    def extended_blocks(self, market, tenor, generic, start, end):
        # Pull up to four successive contracts per request and retain each contract's own roll window.
        periods = windows(FIRST_DAY, today_utc() + timedelta(days=1))
        years = [list(group) for _, group in groupby(periods, key=lambda period: period[1].year)]
        for year in reversed(years):
            first, last = year[0][1], year[-1][2]
            if first >= end or last <= start:
                continue
            codes = {
                delivery: package_code(market, "spread", tenor, generic_delivery(delivery, generic))
                for delivery, _, _ in year
            }
            key = f"{first}-{last}-{market}-{tenor}-S{generic}"
            data, error = self.cached_bars(key, set(codes.values()), first, last)
            for delivery, lower, upper in year:
                if lower < end and upper > start:
                    code = codes[delivery]
                    yield lower, upper, code, data.get(code, ()), error

    def fixed_blocks(self, market, family, tenor, contract, start, end, interval="1H"):
        code = package_code(market, family, tenor, contract)
        # A package cannot trade after its last leg's delivery quarter has ended.
        expiry_limit = month_day(contract + (FAMILIES.get(family, 1) - 1) * tenor + 4)
        for year in range(min(end - timedelta(days=1), expiry_limit - timedelta(days=1)).year, start.year - 1, -1):
            first, last = date(year, 1, 1), min(date(year + 1, 1, 1), expiry_limit)
            if last <= start:
                continue
            key = f"fixed-{year}-{code}" if interval == "1H" else f"fixed-{interval}-{year}-{code}"
            data, error = self.cached_bars(key, {code}, first, last, interval)
            yield first, last, code, data.get(code, ()), error

    def listed_blocks(self, market, family, tenor, start, end, generic):
        for delivery, first, last in reversed(list(windows(start, end))):
            data, error = self.block(delivery, first, last, generic=generic)
            code = package_code(market, family, tenor, generic_delivery(delivery, generic))
            yield first, last, code, data.get(code, ()), error

    def series(self, market, family, tenor, contract, start, end, generic=1, interval="1H"):
        candles = []
        missing = []
        warnings = set()
        if contract is not None:
            blocks = self.fixed_blocks(market, family, tenor, contract, start, end, interval)
        elif generic not in GENERICS:
            blocks = self.extended_blocks(market, tenor, generic, start, end)
        else:
            blocks = self.listed_blocks(market, family, tenor, start, end, generic)
        for first, last, code, bars, error in blocks:
            lower = utc_stamp(max(start, first)) * 1000
            upper = utc_stamp(min(end, last)) * 1000
            selected = [bar for bar in bars if lower <= bar[0] < upper]
            if selected:
                candles.extend([*bar, code] for bar in selected)
            else:
                missing.append([max(start, first).isoformat(), min(end, last).isoformat()])
            if error:
                warnings.add(error)
        candles.sort(key=lambda bar: bar[0])
        return {"candles": candles, "missingWindows": missing, "warnings": sorted(warnings)}


def today_utc():
    return datetime.now(timezone.utc).date()


def selection(params, catalogue):
    def require(key):
        values = params.get(key, ())
        if len(values) != 1:
            raise ValueError(f"Choose a valid {key}.")
        return values[0]

    market, family = require("market"), require("family")
    tenor = int(require("tenor"))
    value = require("contract")
    contract = None if value == "rolling" else int(value)
    package = family in FAMILIES and tenor in TENORS
    fixed = contract is not None and ((family == "out" and tenor == 0) or (family in FAMILIES and tenor == 24))
    if market not in MARKETS or not (package or fixed):
        raise ValueError("Choose a listed market and product type.")
    today = today_utc()
    if contract is not None and not month_index(FIRST_DAY) <= contract <= month_index(today) + 180:
        raise ValueError("Choose a delivery from the contract list.")
    generic = int(require("generic")) if "generic" in params else 1
    if contract is None:
        ranks = listed_spread_ranks(catalogue, market, tenor, today) if family == "spread" else GENERICS
        if generic not in ranks:
            raise ValueError("Choose an available generic for this market and product.")
    start = date.fromisoformat(require("from"))
    through = date.fromisoformat(require("through"))
    if not FIRST_DAY <= start <= through <= today:
        raise ValueError("Choose a date range from 1 January 2021 through today (UTC).")
    interval = require("interval") if "interval" in params else "1H"
    if interval not in {"1H", "1D"} or (interval == "1D" and contract is None):
        raise ValueError("Choose hourly candles or a fixed delivery for daily candles.")
    return market, family, tenor, contract, start, through + timedelta(days=1), generic, interval


if __name__ == "__main__":
    history = HourlyHistory()
    failures = 0
    for delivery, first, last in reversed(list(windows(FIRST_DAY, today_utc() + timedelta(days=1)))):
        for generic, label in ((1, "G1"), (2, "G2/G3")):
            data, error = history.block(delivery, first, last, generic=generic)
            print(f"{first} to {last} {label}: {sum(map(len, data.values())):,} candles" + (f". {error}" if error else ""), flush=True)
            failures += bool(error)
    raise SystemExit(bool(failures))
