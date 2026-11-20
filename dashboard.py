"""Serve the dashboard on loopback and bridge the private L1 feed."""

import argparse
import json
import math
import re
import socket
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
CATALOG = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
INSTRUMENTS = sorted({row["id"] for row in CATALOG})
SERVER = "https://ls.prod-live.hertshtengroup.com/"
CLIENT_ID = "b6bd48fa-55db-41aa-9af8-e74283e478fb"
AUTHORITY = "https://login.microsoftonline.com/0753c1a4-2be6-4a86-8763-32ae847e1186"
SCOPES = ["api://28ab8830-42a2-4400-8ef0-07af1dfc1163/access_as_application"]
SHARED_CACHE = (
    Path.home() / "Downloads" / "LS_updated_auth" / "Lightstreamer - Shareable"
    / ".msal_token_cache.json"
)


def auth_problem(message, result):
    codes = result.get("error_codes") or []
    if isinstance(codes, list) and codes and isinstance(codes[0], int):
        return f"{message} Microsoft error AADSTS{codes[0]}."
    return message


def connection_problem(stage, error):
    description = str(error)
    if "WinError 10013" in description:
        return "Windows blocked outbound network access for this process. Relaunch the dashboard with start-dashboard.cmd and retry."
    if any(word in description.lower() for word in ("ssl", "certificate")):
        return f"{stage} could not verify the HTTPS connection."
    return f"{stage} failed ({type(error).__name__}). Check your network and retry."


class Feed:
    def __init__(self):
        self.lock = threading.Lock()
        self.generation = 0
        self.connection = 0
        self.client = None
        self.cancel = threading.Event()
        self.flow = None
        self.state = "offline"
        self.message = ""
        self.device = None
        self.quotes = {}
        self.received = None
        self.failed_batches = 0
        self.identified_items = set()
        self.remapped_items = set()
        self.unverified_updates = 0

    def snapshot(self):
        with self.lock:
            return {
                "state": self.state, "message": self.message, "device": self.device,
                "quotes": self.quotes.copy(), "received": self.received,
                "failedBatches": self.failed_batches,
                "identifiedItems": len(self.identified_items),
                "remappedItems": len(self.remapped_items),
                "unverifiedUpdates": self.unverified_updates,
            }

    def stop(self):
        with self.lock:
            self.generation += 1
            self.cancel.set()
            if self.flow is not None:
                self.flow["expires_at"] = 0
            client, self.client = self.client, None
            self.flow = self.device = self.received = None
            self.state, self.message = "offline", ""
            self.quotes.clear()
            self.failed_batches = 0
            self.identified_items.clear()
            self.remapped_items.clear()
            self.unverified_updates = 0
        if client is not None:
            client.disconnect()

    def start(self, email):
        with self.lock:
            if self.state not in {"offline", "error"}:
                return False
            old_client, self.client = self.client, None
            self.cancel.set()
            self.cancel = threading.Event()
            generation = self.generation = self.generation + 1
            cancel = self.cancel
            self.quotes.clear()
            self.received = None
            self.failed_batches = 0
            self.state, self.message = "signing-in", "Checking Microsoft sign-in…"
        if old_client is not None:
            old_client.disconnect()
        threading.Thread(target=self.authenticate, args=(generation, cancel, email), daemon=True).start()
        return True

    def error(self, generation, message):
        with self.lock:
            if generation == self.generation and self.state != "error":
                self.state, self.message, self.device = "error", message, None

    def authenticate(self, generation, cancel, email):
        stage = "Microsoft sign-in"
        try:
            import msal
            import lightstreamer.client  # Check availability before asking for sign-in.
        except ImportError:
            self.error(generation, "Live dependencies are missing. Install requirements.txt and restart.")
            return

        try:
            cache = msal.SerializableTokenCache()
            try:
                if SHARED_CACHE.is_file():
                    cache.deserialize(SHARED_CACHE.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                cache = msal.SerializableTokenCache()
            app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY, token_cache=cache, timeout=12)
            accounts = app.get_accounts(username=email)
            result = app.acquire_token_silent(SCOPES, account=accounts[0]) if accounts else None
            if not result or "access_token" not in result:
                flow = app.initiate_device_flow(scopes=SCOPES)
                if "user_code" not in flow:
                    self.error(generation, auth_problem("Microsoft could not start device sign-in.", flow))
                    return
                with self.lock:
                    if generation != self.generation:
                        return
                    self.flow = flow
                    self.message = "Finish Microsoft sign-in with your work account."
                    self.device = {"code": flow["user_code"], "url": "https://microsoft.com/devicelogin"}
                result = app.acquire_token_by_device_flow(flow)
                with self.lock:
                    if generation != self.generation:
                        return
                    self.flow = self.device = None
                claims = result.get("id_token_claims", {})
                username = claims.get("preferred_username") or claims.get("upn")
                if username and username.casefold() != email.casefold():
                    self.error(generation, "Microsoft signed in with a different account. Retry with the email you entered.")
                    return
            if "access_token" not in (result or {}):
                self.error(generation, auth_problem("Microsoft sign-in did not complete. Start a new sign-in to retry.", result or {}))
                return

            while not cancel.is_set():
                stage = "Lightstreamer setup"
                if not self.connect(generation, email, result["access_token"]):
                    return
                refresh_after = max(15, int(result.get("expires_in") or 3600) - 120)
                if cancel.wait(refresh_after):
                    return
                stage = "Microsoft token renewal"
                accounts = app.get_accounts(username=email)
                result = app.acquire_token_silent(SCOPES, account=accounts[0], force_refresh=True) if accounts else None
                if "access_token" not in (result or {}):
                    self.error(generation, "The market-data session expired. Sign in again to resume the feed.")
                    return
        except Exception as error:
            self.error(generation, connection_problem(stage, error))

    def connect(self, generation, email, token):
        from lightstreamer.client import ClientListener, LightstreamerClient, Subscription, SubscriptionListener

        feed = self
        with self.lock:
            if generation != self.generation or self.state == "error":
                return False
            connection = self.connection = self.connection + 1

        def current():
            return generation == feed.generation and connection == feed.connection and feed.state != "error"

        class ConnectionListener(ClientListener):
            def onStatusChange(self, status):
                with feed.lock:
                    if not current():
                        return
                    if status.startswith("CONNECTED:"):
                        feed.state = "connected"
                        feed.message = ""
                    else:
                        feed.state = "connecting"
                        feed.message = "Connecting to Lightstreamer…" if not feed.quotes else "Reconnecting to Lightstreamer…"

            def onServerError(self, code, message):
                with feed.lock:
                    if current():
                        feed.state = "error"
                        feed.message = f"Lightstreamer returned connection error {int(code)}."

        class QuoteListener(SubscriptionListener):
            def __init__(self, instrument_ids):
                self.instrument_ids = frozenset(instrument_ids)

            def onSubscriptionError(self, code, message):
                with feed.lock:
                    if current():
                        feed.failed_batches += 1
                        feed.message = f"Lightstreamer returned subscription error {int(code)}."

            def onItemUpdate(self, update):
                item = update.getItemName()
                instrument_id = (update.getValue("instrumentId") or "").strip().removesuffix("-2")
                if re.fullmatch(r"-\d{1,19}", instrument_id):
                    instrument_id = str(int(instrument_id) + (1 << 64))
                with feed.lock:
                    if not current():
                        return
                    if instrument_id not in self.instrument_ids:
                        feed.unverified_updates += 1
                        return
                    feed.identified_items.add(instrument_id)
                    if item != instrument_id + "-2":
                        feed.remapped_items.add(instrument_id)
                    if not (update.isValueChanged("VWAP") or update.isValueChanged("instrumentId")) and instrument_id in feed.quotes:
                        return
                    try:
                        value = float(update.getValue("VWAP"))
                    except (TypeError, ValueError):
                        value = math.nan
                    if math.isfinite(value):
                        feed.quotes[instrument_id] = value
                        feed.received = time.time()
                    else:
                        feed.quotes.pop(instrument_id, None)

        client = LightstreamerClient(SERVER, "MARKET_DATA")
        client.connectionDetails.setUser(email)
        client.connectionDetails.setPassword(token)
        client.connectionOptions.setFirstRetryMaxDelay(5000)
        client.connectionOptions.setRetryDelay(5000)
        client.addListener(ConnectionListener())
        for start in range(0, len(INSTRUMENTS), 100):
            batch = INSTRUMENTS[start:start + 100]
            items = [instrument_id + "-2" for instrument_id in batch]
            subscription = Subscription("MERGE", items, ["instrumentId", "VWAP"])
            subscription.setDataAdapter("MDS")
            subscription.setRequestedSnapshot("yes")
            subscription.setRequestedMaxFrequency(1)
            subscription.addListener(QuoteListener(batch))
            client.subscribe(subscription)

        with self.lock:
            if not current():
                return False
            old_client, self.client = self.client, client
            self.state, self.message = "connecting", "Connecting to Lightstreamer…"
            self.quotes.clear()
            self.received = None
            self.failed_batches = 0
            self.identified_items.clear()
            self.remapped_items.clear()
            self.unverified_updates = 0
            client.connect()
        if old_client is not None:
            old_client.disconnect()
        return True


FEED = Feed()
FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.mjs": ("app.mjs", "text/javascript; charset=utf-8"),
    "/curve-engine.mjs": ("curve-engine.mjs", "text/javascript; charset=utf-8"),
    "/chart.mjs": ("chart.mjs", "text/javascript; charset=utf-8"),
    "/catalog.json": ("catalog.json", "application/json; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    def valid_host(self):
        return self.headers.get("Host") in {
            f"{host}:{self.server.server_port}" for host in ("localhost", "127.0.0.1")
        }

    def reply(self, body, mime, status=200):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; style-src 'self'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def json_reply(self, payload, status=200):
        self.reply(json.dumps(payload).encode(), "application/json; charset=utf-8", status)

    def do_GET(self):
        if not self.valid_host():
            self.json_reply({"error": "Invalid host."}, 403)
            return
        path = urlsplit(self.path).path
        if path == "/api/feed":
            self.json_reply(FEED.snapshot())
        elif file := FILES.get(path):
            self.reply((ROOT / file[0]).read_bytes(), file[1])
        else:
            self.json_reply({"error": "Page unavailable."}, 404)

    def do_POST(self):
        host = self.headers.get("Host")
        if not self.valid_host() or self.headers.get("Origin") != f"http://{host}":
            self.json_reply({"error": "Open the dashboard locally."}, 403)
            return
        if self.path == "/api/disconnect":
            FEED.stop()
            self.json_reply({"ok": True})
            return
        if self.path != "/api/connect":
            self.json_reply({"error": "Page unavailable."}, 404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024:
                raise ValueError
            payload = json.loads(self.rfile.read(size))
            email = payload["email"]
            if not isinstance(email, str) or not re.fullmatch(r"[A-Za-z0-9._+%-]+@hertshtengroup\.com", email, re.I):
                raise ValueError
        except (ValueError, TypeError, KeyError):
            self.json_reply({"error": "Enter your full Hertshten work email."}, 400)
            return
        started = FEED.start(email)
        self.json_reply({"ok": True} if started else {"error": "A session is already running."}, 200 if started else 409)

    def log_message(self, format, *args):
        pass


class DashboardServer(ThreadingHTTPServer):
    allow_reuse_address = not hasattr(socket, "SO_EXCLUSIVEADDRUSE")
    allow_reuse_port = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    try:
        server = DashboardServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        if error.errno not in {13, 48, 98, 10013, 10048} and getattr(error, "winerror", None) not in {10013, 10048}:
            raise
        parser.exit(1, f"Port {args.port} is already in use or unavailable. Open the running dashboard or choose another port.\n")
    with server:
        url = f"http://127.0.0.1:{server.server_port}/"
        print(f"Intermarket dashboard: {url}", flush=True)
        if not args.no_browser:
            threading.Timer(0.35, webbrowser.open, args=(url,)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            FEED.stop()
