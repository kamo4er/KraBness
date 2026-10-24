#!/usr/bin/env python3
"""KraBness wake service: runs on any always-on box in the home LAN (NAS, Raspberry Pi, router with Python).

A sleeping PC is unreachable over Tailscale, so the phone asks this service (over Tailscale)
to send a Wake-on-LAN magic packet into the LAN.

  GET  /status[?host=&port=]   -> {"pc": "online" | "offline"}   (TCP connect to the hub)
  POST /wake  {"mac", "broadcast"}  -> {"ok": true}                (magic packet)

The app sends the PC MAC, broadcast and hub address (it gets them from the hub settings),
so normally the service needs only a token:

  python3 wake.py --token-file token          # token file: one line, 16+ chars

--mac / --broadcast / --pc-host still work as defaults (older setups pass them).
Every request needs "Authorization: Bearer <token>". With --bind (e.g. the Tailscale IP of this box)
the service listens only there and retries the bind until Tailscale is up (boot order).
Python 3.8+, standard library only.
"""
import argparse
import hmac
import ipaddress
import json
import os
import re
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MAC_RE = re.compile(r"^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.\-]{1,253}$")


def magic_packet(mac: str) -> bytes:
    raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    if len(raw) != 6:
        raise ValueError("bad MAC: " + mac)
    return b"\xff" * 6 + raw * 16


def send_wol(mac: str, broadcast: str, port: int = 9) -> None:
    pkt = magic_packet(mac)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        # a few copies to both broadcasts: UDP may drop one, some NICs listen only on port 7
        for _ in range(3):
            for addr in dict.fromkeys((broadcast, "255.255.255.255")):
                for p in (port, 7):
                    s.sendto(pkt, (addr, p))
            time.sleep(0.1)


def pc_online(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.5):
            return True
    except OSError:
        return False


def valid_broadcast(b: str) -> bool:
    try:
        return ipaddress.ip_address(b).version == 4
    except ValueError:
        return False


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def make_handler(args, token: str):
    class Handler(BaseHTTPRequestHandler):
        def _reply(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            got = self.headers.get("authorization", "")
            return hmac.compare_digest(got.encode(), ("Bearer " + token).encode())

        def _body(self) -> dict:
            n = int(self.headers.get("content-length") or 0)
            if n <= 0 or n > 4096:
                return {}
            try:
                j = json.loads(self.rfile.read(n))
                return j if isinstance(j, dict) else {}
            except ValueError:
                return {}

        def do_GET(self):
            u = urlparse(self.path)
            if u.path != "/status":
                return self._reply(404, {"error": "not found"})
            if not self._authorized():
                return self._reply(401, {"error": "unauthorized"})
            q = parse_qs(u.query)
            host = (q.get("host") or [args.pc_host or ""])[0]
            try:
                port = int((q.get("port") or [args.pc_port])[0])
            except ValueError:
                return self._reply(400, {"error": "bad port"})
            if not host or not HOST_RE.match(host) or not 0 < port < 65536:
                return self._reply(400, {"error": "need host"})
            self._reply(200, {"pc": "online" if pc_online(host, port) else "offline"})

        def do_POST(self):
            if urlparse(self.path).path != "/wake":
                return self._reply(404, {"error": "not found"})
            if not self._authorized():
                return self._reply(401, {"error": "unauthorized"})
            b = self._body()
            mac = str(b.get("mac") or args.mac or "")
            broadcast = str(b.get("broadcast") or args.broadcast)
            if not MAC_RE.match(mac):
                return self._reply(400, {"error": "need mac"})
            if not valid_broadcast(broadcast):
                return self._reply(400, {"error": "bad broadcast"})
            send_wol(mac, broadcast)
            log("wake: magic packet sent to %s via %s" % (mac, broadcast))
            self._reply(200, {"ok": True})

        def log_message(self, fmt, *a):  # tokens must not end up in logs; we log wake ourselves
            pass

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description="KraBness Wake-on-LAN relay")
    ap.add_argument("--bind", default="0.0.0.0", help="address to listen on (e.g. Tailscale IP of this box)")
    ap.add_argument("--port", type=int, default=7421)
    ap.add_argument("--token-file", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "token"))
    ap.add_argument("--mac", help="default PC MAC (the app normally sends it)")
    ap.add_argument("--broadcast", default="255.255.255.255", help="default LAN broadcast")
    ap.add_argument("--pc-host", help="default hub address for /status")
    ap.add_argument("--pc-port", type=int, default=7420)
    ap.add_argument("--once", choices=["wake", "status"], help="do it once and exit (for checks)")
    args = ap.parse_args()

    if args.once == "wake":
        send_wol(args.mac, args.broadcast)
        return print("sent")
    if args.once == "status":
        return print("online" if pc_online(args.pc_host, args.pc_port) else "offline")

    try:
        with open(args.token_file) as f:
            token = f.read().strip()
    except OSError:
        sys.exit("no token file: put the token from KraBness settings into " + args.token_file)
    if len(token) < 16:
        sys.exit("token too short (16+ chars)")

    while True:
        try:
            srv = ThreadingHTTPServer((args.bind, args.port), make_handler(args, token))
            break
        except OSError as e:  # Tailscale not up yet after boot
            log("bind %s:%d failed (%s), retry in 10 s" % (args.bind, args.port, e))
            time.sleep(10)
    log("listening on http://%s:%d" % (args.bind, args.port))
    srv.serve_forever()


if __name__ == "__main__":
    main()
