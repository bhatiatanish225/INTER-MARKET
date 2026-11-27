"""Backfill the dashboard's recent daily closes from the company QuantHub API."""

import argparse
import json
import logging
import math
import os
import ssl
import tempfile
import time
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
CATALOGUE = ROOT / "catalog.json"
BASE_URL = "https://qh-api.corp.hertshtengroup.com/apis/"
BATCH_SIZE = 50
LOOKBACK_DAYS = 560
CLOSE_CHUNK_DAYS = 242
DAY_MS = 86_400_000
QH_SETTINGS = {"QH_API_TOKEN", "QH_API_CA_BUNDLE"}
DEFAULT_ENV_FILE = Path(os.environ.get("LOCALAPPDATA", "")) / "Hertshten" / "QH-MCP-Pilot" / ".env"
LOG = logging.getLogger(__name__)


class CatalogueChanged(RuntimeError):
    """A concurrent update published a newer catalogue."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class QuantHub:
    def __init__(self, env_file, *, ohlc_spacing=2.1):
        settings = {}
        if env_file and env_file.is_file():
            for line in env_file.read_text(encoding="utf-8-sig").splitlines():
                key, separator, value = line.strip().partition("=")
                if separator and key.strip() in QH_SETTINGS:
                    settings[key.strip()] = value.strip().strip('"').strip("'")
        settings.update({key: os.environ[key] for key in QH_SETTINGS if key in os.environ})
        token = settings.get("QH_API_TOKEN", "")
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        if not token or any(ord(char) < 33 or ord(char) > 126 for char in token):
            raise RuntimeError("QuantHub needs a valid token in its local configuration.")
        self.headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
        self.opener = build_opener(
            NoRedirect(), HTTPSHandler(context=ssl.create_default_context(
                cafile=settings.get("QH_API_CA_BUNDLE") or None,
            )),
        )
        self.next_ohlc = 0.0
        self.ohlc_spacing = ohlc_spacing

    def get(self, endpoint, parameters, *, protected=False):
        headers = self.headers if protected else {"Accept": "application/json"}
        request = Request(BASE_URL + endpoint + "?" + urlencode(parameters), headers=headers)
        for attempt in range(2):
            if protected:
                time.sleep(max(0, self.next_ohlc - time.monotonic()))
                self.next_ohlc = time.monotonic() + self.ohlc_spacing
            try:
                with self.opener.open(request, timeout=30) as response:
                    payload = json.load(response)
                if isinstance(payload, dict) and payload.get("status") == "SUCCESS":
                    payload = payload.get("data")
                if not isinstance(payload, list):
                    raise RuntimeError(f"QuantHub returned a different format for {endpoint}.")
                return payload
            except HTTPError as error:
                if error.code != 429 or attempt or not protected:
                    raise RuntimeError(f"QuantHub returned HTTP {error.code} for {endpoint}.") from None
                try:
                    delay = float(error.headers.get("Retry-After", "30"))
                except ValueError:
                    delay = 30
                if not math.isfinite(delay) or delay > 60:
                    raise RuntimeError("QuantHub asked for a longer cooldown. Try again later.") from None
                self.next_ohlc = time.monotonic() + max(self.ohlc_spacing, delay)
            except (URLError, TimeoutError):
                raise RuntimeError("QuantHub could not be reached. Check company network access.") from None

    def closes(self, instrument_ids, start, end):
        bars = self.get("ohlc/", {
            "hg_instrument_ids": ",".join(instrument_ids),
            "interval": "1D",
            "start": int(start.timestamp()),
            "end": int(end.timestamp()),
        }, protected=True)
        codes = sorted({bar["product"] for bar in bars})
        if not codes:
            return {}
        matches = {}
        allowed = set(instrument_ids)
        for i in range(0, len(codes), BATCH_SIZE):
            records = self.get("common/instruments/", {
                "qh_codes": ",".join(codes[i:i + BATCH_SIZE]),
                "limit": BATCH_SIZE,
            })
            for row in records:
                code = row.get("quant_code")
                instrument = str(row.get("hg_instrument_id", ""))
                if code in codes and instrument in allowed:
                    matches.setdefault(code, set()).add(instrument)
        closes = {}
        for bar in bars:
            instruments = matches.get(bar["product"], set())
            price, volume, stamp = bar.get("close"), bar.get("volume"), bar.get("time")
            if (len(instruments) != 1 or type(price) not in (int, float) or not math.isfinite(price)
                    or type(volume) not in (int, float) or volume <= 0 or type(stamp) is not int):
                continue
            instrument = next(iter(instruments))
            day = stamp // DAY_MS
            if int(start.timestamp()) // 86400 <= day < int(end.timestamp()) // 86400:
                current = closes.setdefault(instrument, {})
                if day in current and current[day] != price:
                    raise RuntimeError("QuantHub returned conflicting daily closes for the same instrument.")
                current[day] = price
        return closes


def publish(catalogue, source):
    staged = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=ROOT, delete=False) as output:
            staged = Path(output.name)
            json.dump(catalogue, output, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
        for attempt in range(5):
            if CATALOGUE.read_bytes() != source:
                raise CatalogueChanged("The instrument catalogue changed during the refresh. Try again later.")
            try:
                staged.replace(CATALOGUE)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                # Windows can briefly lock the catalogue while it is being served.
                time.sleep(0.25)
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)


def record_failure(started_at):
    failed_at = datetime.now(timezone.utc)
    for attempt in range(3):
        source = CATALOGUE.read_bytes()
        catalogue = json.loads(source)
        if any(
            (record.get("historyRefreshedAt")
             and datetime.fromisoformat(record["historyRefreshedAt"]) >= started_at)
            or (record.get("historyRefreshFailedAt")
                and datetime.fromisoformat(record["historyRefreshFailedAt"]) >= failed_at)
            for record in catalogue
        ):
            return
        for record in catalogue:
            record["historyRefreshFailedAt"] = failed_at.isoformat(timespec="milliseconds")
        try:
            publish(catalogue, source)
            return
        except CatalogueChanged:
            if attempt == 2:
                raise


def refresh_closes(env_file):
    source = CATALOGUE.read_bytes()
    catalogue = json.loads(source)
    ids = [row["id"] for row in catalogue]
    if len(set(ids)) != len(ids):
        raise RuntimeError("The catalogue contains duplicate instrument IDs.")
    end = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start = end - timedelta(days=LOOKBACK_DAYS + 2)
    client = QuantHub(env_file, ohlc_spacing=3.5)
    results = {}
    LOG.info("Refreshing QuantHub daily closes for %d instrument IDs.", len(ids))
    for i in range(0, len(ids), BATCH_SIZE):
        batch = ids[i:i + BATCH_SIZE]
        through = end
        while through > start:
            first = max(start, through - timedelta(days=CLOSE_CHUNK_DAYS))
            for instrument, closes in client.closes(batch, first, through).items():
                results.setdefault(instrument, {}).update(closes)
            through = first
        LOG.info("Checked %d of %d IDs. Traded closes for %d instruments.", i + len(batch), len(ids), len(results))
    if not results:
        raise RuntimeError("QuantHub returned no mapped traded closes for the catalogue.")
    refreshed_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    for record in catalogue:
        record.pop("dailyCloses", None)
        record.pop("historyRefreshedAt", None)
        record.pop("historyRefreshFailedAt", None)
        if record["id"] in results:
            record["dailyCloses"] = sorted(results[record["id"]].items())
            record["historyRefreshedAt"] = refreshed_at
    publish(catalogue, source)
    LOG.info("Loaded %s daily closes across %d instruments.", f"{sum(map(len, results.values())):,}", len(results))


def refresh(env_file):
    started_at = datetime.now(timezone.utc)
    try:
        refresh_closes(env_file)
    except Exception:
        try:
            record_failure(started_at)
        except Exception:
            LOG.error("Could not publish the failed QuantHub refresh status.")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE, help="Existing local QuantHub configuration")
    parser.add_argument("--log-file", type=Path, help="Write refresh status to a rotating local log")
    options = parser.parse_args()
    handler = (RotatingFileHandler(options.log_file, maxBytes=100_000, backupCount=1, encoding="utf-8")
               if options.log_file else logging.StreamHandler())
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)
    try:
        refresh(options.env_file)
    except Exception as error:
        LOG.error("Refresh failed. %s", error)
        raise SystemExit(1) from None
