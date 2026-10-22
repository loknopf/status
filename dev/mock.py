#!/usr/bin/env python3
"""Serve web/public with a fake Gatus API: 90 days of made-up history in any state.

    python3 dev/mock.py --state outage [--announce] [--port 8090]

States: operational, degraded (Grafana slow), outage (n8n down, Nextcloud slow).
Needs web/public/endpoints.json; generate it from the config with:

    docker run --rm -v "$PWD":/w -w /w mikefarah/yq:4.54.1 \
        -o=json -I=0 --from-file web/endpoints.yq config/config.yaml > web/public/endpoints.json
"""

import argparse
import json
import random
import re
import sys
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public"
NOW = datetime.now(timezone.utc)


def key_of(group, name):
    clean = lambda s: re.sub(r"[/_.,# +&]", "-", s.strip().lower())
    return f"{clean(group)}_{clean(name)}"


def iso(t):
    return t.isoformat().replace("+00:00", "Z")


def go_duration(td):
    total = int(td.total_seconds())
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}h{m}m{s}s"


class Fake:
    """One endpoint: events over 90 days plus a current state."""

    def __init__(self, meta, current):
        self.meta = meta
        self.name, self.group = meta["name"], meta["group"]
        self.key = key_of(self.group, self.name)
        self.tls = meta["url"].startswith("tls://")
        self.proxy = self.group == "Infrastructure"
        self.current = current  # up | slow | down
        rnd = random.Random(self.key)
        self.base_ms = 12 if self.proxy else rnd.randint(60, 320)
        self.cert = timedelta(days=rnd.randint(20, 80), hours=rnd.randint(0, 23))
        start = NOW - timedelta(days=89, hours=14)
        self.events = [{"type": "START", "timestamp": iso(start)}, {"type": "HEALTHY", "timestamp": iso(start)}]
        incidents = [] if self.tls or self.proxy else sorted(rnd.sample(range(2, 86), rnd.randint(0, 3)))
        for day in incidents:
            t = NOW - timedelta(days=day, hours=rnd.randint(0, 20), minutes=rnd.randint(0, 59))
            length = timedelta(minutes=rnd.choice([1, 2, 3, 12, 47]))
            self.events.append({"type": "UNHEALTHY", "timestamp": iso(t)})
            self.events.append({"type": "HEALTHY", "timestamp": iso(t + length)})
        if current != "up":
            since = NOW - timedelta(minutes=12 if current == "down" else 25)
            self.events.append({"type": "UNHEALTHY", "timestamp": iso(since)})
        self.events.sort(key=lambda e: e["timestamp"])
        self.rnd = rnd

    def failing_ms(self, since):
        bad, total = None, 0
        for e in self.events:
            t = datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00"))
            if e["type"] == "UNHEALTHY":
                bad = t
            elif e["type"] == "HEALTHY" and bad:
                total += max(0, (t - max(bad, since)).total_seconds())
                bad = None
        if bad:
            total += (NOW - max(bad, since)).total_seconds()
        return total * 1000

    def uptime(self, window):
        since = max(NOW - window, datetime.fromisoformat(self.events[0]["timestamp"].replace("Z", "+00:00")))
        span = (NOW - since).total_seconds() * 1000
        return 1 - self.failing_ms(since) / span

    def result(self, age):
        down = self.current == "down" and age < 12
        slow = self.current == "slow" and age < 25
        ms = self.base_ms + self.rnd.randint(-15, 25) + (1800 if slow else 0)
        cert = go_duration(self.cert)
        if self.tls:
            conds = [("[CONNECTED] (true) == true", True), (f"[CERTIFICATE_EXPIRATION] ({cert}) > 168h", True)]
        elif down:
            conds = [("[STATUS] (0) == 200", False), ("[RESPONSE_TIME] (10000) < 1500", False),
                     ("[CERTIFICATE_EXPIRATION] (0s) > 168h", False)]
        else:
            code = 401 if self.proxy else 200
            conds = [(f"[STATUS] ({code}) == {code}", True), (f"[RESPONSE_TIME] ({ms}) < 1500", ms < 1500),
                     (f"[CERTIFICATE_EXPIRATION] ({cert}) > 168h", True)]
        r = {
            "duration": (10_000 if down else ms) * 1_000_000,
            "conditionResults": [{"condition": c, "success": ok} for c, ok in conds],
            "success": all(ok for _, ok in conds),
            "timestamp": iso(NOW - timedelta(minutes=age, seconds=7)),
        }
        if down:
            r["errors"] = [f'Get "{self.meta["url"]}": context deadline exceeded (Client.Timeout exceeded)']
        else:
            r["status"] = 0 if self.tls else (401 if self.proxy else 200)
            if not self.proxy:
                r["hostname"] = re.sub(r"^\w+://([^/:]+).*$", r"\1", self.meta["url"])
        return r

    def status(self, results=1, with_events=False):
        out = {"name": self.name, "group": self.group, "key": self.key,
               "results": [self.result(age) for age in reversed(range(results))]}
        if with_events:
            out["events"] = self.events
        return out


def build(state):
    metas = json.loads((PUBLIC / "endpoints.json").read_text())
    current = {"outage": {"n8n": "down", "Nextcloud": "slow"}, "degraded": {"Grafana": "slow"}}.get(state, {})
    return {f.key: f for f in (Fake(m, current.get(m["name"], "up") if m["group"] != "Certificates" else "up")
                               for m in metas)}


class Server(ThreadingHTTPServer):
    request_queue_size = 64  # the page fires ~15 requests at once


class Handler(SimpleHTTPRequestHandler):
    fakes = {}
    announce = False

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if not path.startswith("/api/"):
            if path.endswith(".html") or path == "/":
                return self.html(path)
            return super().do_GET()
        m = re.fullmatch(r"/api/v1/endpoints/([^/]+)/(.+)", path)
        if path == "/api/v1/endpoints/statuses":
            return self.json([f.status() for f in self.fakes.values()])
        if path == "/api/v1/config":
            ann = [{"timestamp": iso(NOW - timedelta(minutes=10)), "type": "outage",
                    "message": "n8n is not responding\nAutomations and deploy hooks are paused. "
                               "Next update within 30 minutes."}] if self.announce else []
            return self.json({"announcements": ann, "authenticated": True, "oidc": False})
        if not m or m.group(1) not in self.fakes:
            return self.send_error(404)
        f, rest = self.fakes[m.group(1)], m.group(2)
        if rest == "statuses":
            return self.json(f.status(results=8, with_events=True))
        if rest.startswith("uptimes/"):
            window = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}[rest[8:]]
            return self.text(f"{f.uptime(window):f}")
        if rest == "response-times/7d":
            return self.text(str(f.base_ms + 4))
        if rest == "response-times/24h/history":
            start = NOW.replace(minute=0, second=0, microsecond=0) - timedelta(hours=24)
            ts = [int((start + timedelta(hours=i)).timestamp() * 1000) for i in range(25)]
            vals = [f.base_ms + f.rnd.randint(-20, 30) + (180 if i == 15 else 0) for i in range(25)]
            if f.current == "down":
                vals[-1] = 0
            return self.json({"timestamps": ts, "values": vals})
        return self.send_error(404)

    def html(self, path):
        file = PUBLIC / ("index.html" if path == "/" else path.lstrip("/"))
        if not file.is_file():
            return self.send_error(404)
        body = file.read_text().replace("__GIT_SHA_SHORT__", "mock").replace("__GIT_SHA__", "main")
        self.reply(body.encode(), "text/html; charset=utf-8")

    def json(self, data):
        self.reply(json.dumps(data).encode(), "application/json")

    def text(self, data):
        self.reply(data.encode(), "text/plain")

    def reply(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--state", choices=["operational", "degraded", "outage"], default="operational")
    p.add_argument("--announce", action="store_true", help="add a written announcement (incident banner)")
    p.add_argument("--port", type=int, default=8090)
    args = p.parse_args()
    if not (PUBLIC / "endpoints.json").is_file():
        sys.exit("web/public/endpoints.json is missing; see the command at the top of this file.")
    Handler.fakes = build(args.state)
    Handler.announce = args.announce
    server = Server(("127.0.0.1", args.port), partial(Handler, directory=str(PUBLIC)))
    print(f"mock status page ({args.state}) on http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
