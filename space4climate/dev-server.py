#!/usr/bin/env python3
"""Local static server plus /api/orbit for the Orbit Scheduler."""
from __future__ import annotations

import json
import os
import re
import secrets
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / ".orbit-data"
MAX_BYTES = 256 * 1024
SLOT_KEY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}$")
DATA_DIR.mkdir(exist_ok=True)


VERCEL_JSON = ROOT.parent / "vercel.json"


def load_redirects():
    """Same-site redirects from vercel.json, so old URLs behave locally as they do on Vercel."""
    try:
        config = json.loads(VERCEL_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rules = []
    for rule in config.get("redirects", []):
        destination = rule.get("destination", "")
        if destination.startswith(("http://", "https://")):
            continue  # off-site redirects only apply on Vercel
        pattern = re.sub(r":\w+\*", "(.*)", rule.get("source", ""))
        pattern = re.sub(r"\.(?!\*)", r"\\.", pattern)
        rules.append((re.compile("^" + pattern + "$"), destination))
    return rules


def new_id() -> str:
    return "ob_" + secrets.token_urlsafe(8).replace("-", "").replace("_", "")[:12]


def board_path(board_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9._-]", "", board_id)[:80]
    return DATA_DIR / f"{safe}.json"


def normalise_board(raw, fallback_id: str):
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or "").strip()[:120]
    start_date = raw.get("startDate") if isinstance(raw.get("startDate"), str) else None
    end_date = raw.get("endDate") if isinstance(raw.get("endDate"), str) else None
    try:
        start_hour = int(raw.get("startHour"))
        end_hour = int(raw.get("endHour"))
    except (TypeError, ValueError):
        return None
    if not title or not start_date or not end_date:
        return None
    if start_date > end_date or start_hour < 0 or end_hour > 24 or start_hour >= end_hour:
        return None
    raw_id = str(raw.get("id") or "").strip()
    board_id = fallback_id if (not raw_id or raw_id == "pending") else raw_id
    return {
        "id": board_id,
        "title": title,
        "startDate": start_date,
        "endDate": end_date,
        "startHour": start_hour,
        "endHour": end_hour,
        "timezone": raw.get("timezone") if isinstance(raw.get("timezone"), str) else "",
        "createdAt": int(raw.get("createdAt") or 0) or int(__import__("time").time() * 1000),
    }


def normalise_document(raw, fallback_id: str):
    if not isinstance(raw, dict):
        return None
    board = normalise_board(raw.get("board") if isinstance(raw.get("board"), dict) else raw, fallback_id)
    if not board:
        return None
    participants = {}
    incoming = raw.get("participants") if isinstance(raw.get("participants"), dict) else {}
    for key, value in incoming.items():
        if not isinstance(value, dict):
            continue
        pid = str(value.get("id") or key).strip()
        name = str(value.get("name") or "").strip()[:40]
        if not pid or not name:
            continue
        slots = value.get("slots") if isinstance(value.get("slots"), list) else []
        slots = sorted({s for s in slots if isinstance(s, str) and SLOT_KEY_RE.match(s)})
        participants[pid] = {"id": pid, "name": name, "slots": slots}
        if value.get("mergedAt"):
            participants[pid]["mergedAt"] = value.get("mergedAt")
    booking = None
    raw_booking = raw.get("booking")
    if isinstance(raw_booking, dict):
        slot = raw_booking.get("slot") if isinstance(raw_booking.get("slot"), str) else ""
        bid = str(raw_booking.get("id") or "").strip()[:32]
        if SLOT_KEY_RE.match(slot or "") and bid:
            booking = {
                "slot": slot,
                "id": bid,
                "bookedAt": int(raw_booking.get("bookedAt") or 0) or int(__import__("time").time() * 1000),
                "name": str(raw_booking.get("name") or "").strip()[:40],
            }
    return {
        "board": board,
        "participants": participants,
        "booking": booking,
        "updatedAt": int(raw.get("updatedAt") or 0) or int(__import__("time").time() * 1000),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Never let the browser serve stale pages while previewing edits
        if not self.path.startswith("/api/orbit"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def do_OPTIONS(self):
        if self.path.startswith("/api/orbit"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/orbit":
            return self.handle_orbit("GET", parsed)
        path = urllib.parse.unquote(parsed.path)
        for pattern, destination in load_redirects():
            if pattern.match(path):
                # 307 locally so browsers don't cache redirects while developing
                self.send_response(307)
                self.send_header("Location", destination)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/orbit":
            return self.handle_orbit("POST", parsed)
        self.send_error(404)

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/orbit":
            return self.handle_orbit("PUT", parsed)
        self.send_error(404)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BYTES:
            raise ValueError("payload too large")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_orbit(self, method, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        board_id = (query.get("id") or [None])[0]
        try:
            if method == "GET" and not board_id:
                files = list(DATA_DIR.glob("*.json"))
                return self.send_json(200, {"ok": True, "service": "orbit", "boards": len(files)})
            if method == "GET":
                path = board_path(board_id)
                if not path.exists():
                    return self.send_json(404, {"error": "not found"})
                data = json.loads(path.read_text(encoding="utf-8"))
                return self.send_json(200, data)
            if method == "POST":
                incoming = self.read_json()
                preferred = ""
                if isinstance(incoming.get("board"), dict):
                    preferred = str(incoming["board"].get("id") or "")
                preferred = preferred or incoming.get("id") or new_id()
                doc = normalise_document(incoming, preferred)
                if not doc:
                    return self.send_json(400, {"error": "invalid board"})
                stored_id = doc["board"]["id"] or new_id()
                doc["board"]["id"] = stored_id
                board_path(stored_id).write_text(json.dumps(doc), encoding="utf-8")
                return self.send_json(201, {"id": stored_id, **doc})
            if method == "PUT":
                if not board_id:
                    return self.send_json(400, {"error": "missing id"})
                incoming = self.read_json()
                doc = normalise_document(incoming, board_id)
                if not doc:
                    return self.send_json(400, {"error": "invalid board"})
                doc["board"]["id"] = board_id
                board_path(board_id).write_text(json.dumps(doc), encoding="utf-8")
                return self.send_json(200, {"ok": True, **doc})
            return self.send_json(405, {"error": "method not allowed"})
        except Exception as err:
            return self.send_json(500, {"error": str(err)})


def main():
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving Space4Climate on http://127.0.0.1:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
