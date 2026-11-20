"""Import the six contract exports used by the dashboard."""

import argparse
import csv
import json
import math
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).parent
NEXTGEN_IDS = ROOT / "nextgen-instrument-ids.json"
FILES = {
    "SR3": ("src outirght curve inst is", "SR3 spread inst id"),
    "I": ("I outreight inst id", "I (Euribor spreads ) all inst id"),
    "SO3": ("So3 outirght inst isd", "SO3 spread Ins id"),
}
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
TENORS = {3, 6, 12, 24}
DELIVERY = r"([A-Z][a-z]{2}\d{2})"


def month_index(code):
    return (2000 + int(code[3:])) * 12 + MONTHS.index(code[:3])


def contract_key(name):
    if match := re.fullmatch(DELIVERY, name):
        return "out", month_index(match[1]), 0
    if match := re.fullmatch(DELIVERY + "-" + DELIVERY + r" Calendar", name):
        start = month_index(match[1])
        return "spread", start, month_index(match[2]) - start
    if match := re.fullmatch(DELIVERY + r" (\d+)mo Butterfly", name):
        return "fly", month_index(match[1]), int(match[2])
    if match := re.fullmatch(DELIVERY + "[- ]" + DELIVERY + "[- ]" + DELIVERY + r" Butterfly", name):
        start, middle, end = map(month_index, match.groups())
        if middle - start == end - middle:
            return "fly", start, middle - start
    if match := re.fullmatch(DELIVERY + r" (\d+)yr Butterfly", name):
        return "fly", month_index(match[1]), 12 * int(match[2])
    return None


def number(value):
    try:
        result = float(value.replace(",", ""))
    except (AttributeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def add_nextgen_ids(contracts):
    """Add verified RTD identifiers and keep any matching export prices."""
    if not NEXTGEN_IDS.is_file():
        return
    known_ids = {row["id"]: key for key, row in contracts.items()}
    for item in json.loads(NEXTGEN_IDS.read_text(encoding="utf-8")):
        market, _, description = item["contract"].partition(" ")
        key = contract_key(description)
        instrument_id = item["instrumentId"]
        if market not in FILES or not key or not re.fullmatch(r"\d{1,20}", instrument_id):
            raise ValueError(f"Invalid NextGen entry for {item['contract']}")
        family, start, tenor = key
        if family != "out" and tenor not in TENORS:
            raise ValueError(f"Unsupported NextGen contract {item['contract']}")
        full_key = (market, family, start, tenor)
        existing = contracts.get(full_key)
        if (existing and existing["id"] != instrument_id) or known_ids.get(instrument_id, full_key) != full_key:
            raise ValueError(f"Conflicting NextGen ID for {item['contract']}")
        if existing:
            continue
        contracts[full_key] = {
            "market": market, "family": family, "start": start, "tenor": tenor,
            "id": instrument_id, "mark": None, "markSource": None, "settle": None,
        }
        known_ids[instrument_id] = full_key


def load_catalog(folder):
    contracts = {}
    for market, files in FILES.items():
        for filename in files:
            with (folder / filename).open(encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    product, _, description = row["contract"].strip().partition(" ")
                    if product != market:
                        continue
                    key = contract_key(description)
                    if not key or (key[0] != "out" and key[2] not in TENORS):
                        continue
                    family, start, tenor = key
                    instrument_id = row["instrumentId"].strip()
                    if not re.fullmatch(r"\d+", instrument_id):
                        raise ValueError(f"Missing instrument ID for {row['contract']}")
                    last, settle = number(row.get("last")), number(row.get("settle"))
                    record = {
                        "market": market, "family": family, "start": start, "tenor": tenor,
                        "id": instrument_id, "mark": last if last is not None else settle,
                        "markSource": "Export last" if last is not None else "Export settle",
                        "settle": settle,
                    }
                    full_key = (market, family, start, tenor)
                    if full_key in contracts and contracts[full_key]["id"] != instrument_id:
                        raise ValueError(f"Ambiguous IDs for {row['contract']}")
                    contracts[full_key] = record
    add_nextgen_ids(contracts)
    return sorted(contracts.values(), key=lambda row: (
        row["market"], row["family"], row["start"], row["tenor"],
    ))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Folder containing the original instrument exports")
    args = parser.parse_args()
    catalog = load_catalog(args.source)
    destination = ROOT / "catalog.json"
    if destination.is_file():
        prior = json.loads(destination.read_text(encoding="utf-8"))
        fields = ("id", "market", "family", "start", "tenor")
        daily = {
            tuple(row[field] for field in fields): {
                name: row[name]
                for name in ("dailyCloses", "historyRefreshedAt", "historyRefreshFailedAt")
                if name in row
            }
            for row in prior if row.get("dailyCloses") or row.get("historyRefreshFailedAt")
        }
        for row in catalog:
            key = tuple(row[field] for field in fields)
            if key in daily:
                row.update(daily[key])
    destination.write_text(
        json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8",
    )
    for market, count in sorted(Counter(row["market"] for row in catalog).items()):
        print(f"{market}: {count} listed instruments")
