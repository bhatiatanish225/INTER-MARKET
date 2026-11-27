"""Calculate structure candles from synchronized traded leg closes."""

import hashlib
import json
import math
from datetime import date, timedelta

from hourly_history import FAMILIES, FIRST_DAY, MARKETS, TENORS, month_index, package_code, today_utc, utc_stamp

INTERVALS = {
    "10m": (600_000, "5M", 7),
    "1h": (3_600_000, "5M", 7),
    "1d": (86_400_000, "1H", 90),
}


DAY_MS = 86_400_000


def require(params, key):
    values = params.get(key, ())
    if len(values) != 1:
        raise ValueError(f"Choose a valid {key}.")
    return values[0]


def request_parameters(params):
    interval = require(params, "interval")
    today = today_utc()
    start = date.fromisoformat(require(params, "from"))
    through = date.fromisoformat(require(params, "through"))
    if interval not in INTERVALS or not FIRST_DAY <= start <= through <= today:
        raise ValueError("Choose a supported interval and a date range from January 2021 through today (UTC).")
    legs, codes = parse_legs(require(params, "legs"), today)
    return interval, start, through + timedelta(days=1), legs, codes


def parse_legs(payload, today):
    sets = json.loads(payload)
    if not isinstance(sets, list) or not 1 <= len(sets) <= len(MARKETS):
        raise ValueError("Choose up to three market series.")
    legs = []
    for orders in sets:
        if not isinstance(orders, list) or not orders:
            raise ValueError("Add at least one leg per market series.")
        weights = {}
        for order in orders:
            if not isinstance(order, list) or len(order) != 5:
                raise ValueError("Each leg needs a market, product, delivery month and weight.")
            market, family, delivery, tenor, weight = order
            if (not isinstance(market, str) or market not in MARKETS or not isinstance(family, str)
                    or type(tenor) is not int or type(delivery) is not int
                    or not month_index(FIRST_DAY) <= delivery <= month_index(today) + 180
                    or type(weight) not in (int, float) or not 0 < abs(weight) <= 1e12
                    or not ((family == "out" and tenor == 0) or (family in FAMILIES and tenor in (*TENORS, 24)))):
                raise ValueError("Choose valid delivery months, products and nonzero weights for the legs.")
            code = package_code(market, family, tenor, delivery)
            weights[code] = weights.get(code, 0) + weight * (100 if family == "out" else 1)
        legs.append(weights)
    codes = set().union(*legs)
    if len(codes) > 50:
        raise ValueError("QuantHub supports at most 50 distinct contracts per request.")
    return legs, codes


def code_key(codes):
    return hashlib.sha256(",".join(sorted(codes)).encode()).hexdigest()[:24]


def weighted_path(weights, samples):
    shortest = min((samples[code] for code in weights), key=len)
    for stamp in shortest:
        if all(stamp in samples[code] for code in weights):
            value = sum(weight * samples[code][stamp] for code, weight in weights.items())
            if math.isfinite(value):
                yield stamp, value


def previous_closes(history, params):
    today = today_utc()
    legs, codes = parse_legs(require(params, "legs"), today)
    # Recent daily bars cover weekends and market holidays. Today's bar can still be forming.
    first = today - timedelta(days=14)
    data, warning = history.cached_bars(f"structure-1D-{today}-{code_key(codes)}", codes, first, today, "1D")
    through = utc_stamp(today) * 1000
    samples = {code: {bar[0] // DAY_MS: bar[4] for bar in data.get(code, ()) if bar[0] < through} for code in codes}
    closes = []
    for weights in legs:
        latest = max(weighted_path(weights, samples), default=None)
        closes.append(None if latest is None else {
            "date": (date(1970, 1, 1) + timedelta(days=latest[0])).isoformat(), "value": latest[1],
        })
    return {"closes": closes, "warning": warning}


def candles(path, duration):
    bars = []
    for stamp, value in path:
        stamp = stamp // duration * duration
        if bars and bars[-1][0] == stamp:
            bar = bars[-1]
            bar[2] = max(bar[2], value)
            bar[3] = min(bar[3], value)
            bar[4] = value
            bar[5] += 1
        else:
            bars.append([stamp, value, value, value, value, 1])
    return bars


def structure_bars(history, interval, start, end, legs, codes):
    duration, source, chunk_size = INTERVALS[interval]
    # Align cache windows across requests and stay within QuantHub's practical response size.
    epoch = FIRST_DAY.toordinal()
    first_index = start.toordinal() - (start.toordinal() - epoch) % chunk_size
    last_index = first_index + (end.toordinal() - 1 - first_index) // chunk_size * chunk_size
    paths = [{} for _ in legs]
    warnings = set()
    ordered = sorted(codes)
    for index in range(last_index, first_index - 1, -chunk_size):
        first, last = date.fromordinal(index), date.fromordinal(index + chunk_size)
        lower = utc_stamp(max(first, start)) * 1000
        upper = utc_stamp(min(last, end)) * 1000
        data = {}
        # Limit each upstream response while using the same calendar blocks for every strategy.
        for i in range(0, len(ordered), 8):
            chunk, error = history.cached_bars(f"structure-{source}-{chunk_size}-{first}", set(ordered[i:i + 8]),
                                               first, last, source, shared=True)
            data.update(chunk)
            if error:
                warnings.add(error)
        samples = {code: {bar[0]: bar[4] for bar in data.get(code, ()) if lower <= bar[0] < upper} for code in codes}
        for path, weights in zip(paths, legs):
            path.update(weighted_path(weights, samples))
    primary = paths[0]
    differences = [{stamp: value - other[stamp] for stamp, value in primary.items() if stamp in other} for other in paths[1:]]
    return {"series": [candles(sorted(path.items()), duration) for path in (*paths, *differences)],
            "sample": source, "warnings": sorted(warnings)}
