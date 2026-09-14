#!/usr/bin/env python3
"""sip-test-server: a tiny local SIP registrar + proxy for exercising a softphone.

Standard library only. Not a production proxy: it is stateless-ish, single
domain, and deliberately small. See tools/sip-test-server.md for usage.
"""

import argparse
import hashlib
import json
import os
import random
import re
import secrets
import select
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
from email.utils import formatdate

SERVER_NAME = "sipper-test-server/1.0"
ALLOW_METHODS = ("INVITE", "ACK", "BYE", "CANCEL", "OPTIONS", "INFO", "REFER",
                 "NOTIFY", "MESSAGE", "UPDATE", "PRACK", "SUBSCRIBE", "REGISTER")
PROXIED_METHODS = ("INVITE", "ACK", "BYE", "CANCEL", "OPTIONS", "INFO", "REFER",
                   "NOTIFY", "MESSAGE", "UPDATE", "PRACK", "SUBSCRIBE")
SPECIAL_NUMBERS = ("*97", "*echo")
NONCE_LIFETIME = 600
DEFAULT_EXPIRES = 3600
CERT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".sip-test-certs")

COMPACT = {"v": "Via", "f": "From", "t": "To", "i": "Call-ID", "m": "Contact",
           "c": "Content-Type", "l": "Content-Length", "s": "Subject", "k": "Supported",
           "e": "Content-Encoding", "o": "Event", "u": "Allow-Events", "r": "Refer-To",
           "b": "Referred-By", "x": "Session-Expires", "a": "Accept-Contact", "j": "Reject-Contact"}

REASONS = {100: "Trying", 180: "Ringing", 200: "OK", 202: "Accepted", 400: "Bad Request",
           401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 407: "Proxy Authentication Required",
           480: "Temporarily Unavailable", 481: "Call/Transaction Does Not Exist",
           483: "Too Many Hops", 486: "Busy Here", 487: "Request Terminated",
           500: "Server Internal Error", 501: "Not Implemented", 503: "Service Unavailable"}

VERBOSE = False
LOG_LOCK = threading.Lock()


def log(line):
    with LOG_LOCK:
        sys.stdout.write("%s %s\n" % (time.strftime("%H:%M:%S"), line))
        sys.stdout.flush()


def log_message(direction, transport, addr, data):
    if not VERBOSE:
        return
    text = data.decode("utf-8", "replace").rstrip("\r\n")
    text = re.sub(r"[^\x20-\x7e\n\r\t\u0080-\uffff]", ".", text)
    with LOG_LOCK:
        sys.stdout.write("%s %s %s %s:%d\n%s\n\n" % (
            time.strftime("%H:%M:%S"), direction, transport.upper(), addr[0], addr[1],
            "\n".join("    " + l for l in text.split("\n"))))
        sys.stdout.flush()


class SipError(Exception):
    pass


# ---------------------------------------------------------------- parsing helpers

def split_values(value):
    """Split a comma separated header value, ignoring commas in quotes or <>."""
    parts, depth, quoted, cur = [], 0, False, []
    for ch in value:
        if ch == '"':
            quoted = not quoted
        elif not quoted and ch == "<":
            depth += 1
        elif not quoted and ch == ">":
            depth = max(0, depth - 1)
        elif ch == "," and not quoted and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    tail = "".join(cur).strip()
    if tail:
        parts.append(tail)
    return parts


def parse_params(text):
    """';a=b;c' -> {'a': 'b', 'c': None} (keys lower-cased, order kept)."""
    params = {}
    for piece in text.split(";"):
        piece = piece.strip()
        if not piece:
            continue
        if "=" in piece:
            k, v = piece.split("=", 1)
            params[k.strip().lower()] = v.strip().strip('"')
        else:
            params[piece.lower()] = None
    return params


def format_params(params):
    out = []
    for k, v in params.items():
        out.append(";%s" % k if v is None else ";%s=%s" % (k, v))
    return "".join(out)


URI_RE = re.compile(r"^(sips?):(?:([^@;?>]*)@)?(\[[^\]]+\]|[^:;?>\s]+)(?::(\d+))?((?:;[^;?>]*)*)(\?[^>]*)?$")


class Uri:
    def __init__(self, scheme, user, host, port, params, headers=""):
        self.scheme, self.user, self.host, self.port, self.params, self.headers = \
            scheme, user, host, port, params, headers

    @classmethod
    def parse(cls, text):
        m = URI_RE.match(text.strip())
        if not m:
            raise SipError("bad URI: %r" % text)
        scheme, user, host, port, params, headers = m.groups()
        return cls(scheme, user, host.strip("[]"), int(port) if port else None,
                   parse_params(params or ""), headers or "")

    @property
    def transport(self):
        if self.scheme == "sips":
            return "tls"
        return (self.params.get("transport") or "udp").lower()

    def __str__(self):
        host = "[%s]" % self.host if ":" in self.host else self.host
        s = "%s:%s%s" % (self.scheme, (self.user + "@") if self.user else "", host)
        if self.port:
            s += ":%d" % self.port
        return s + format_params(self.params) + self.headers


class NameAddr:
    """'"Bob" <sip:bob@x>;tag=1' -> display, uri, params."""
    def __init__(self, display, uri, params):
        self.display, self.uri, self.params = display, uri, params

    @classmethod
    def parse(cls, text):
        text = text.strip()
        if "<" in text:
            display, rest = text.split("<", 1)
            uri_text, _, tail = rest.partition(">")
            return cls(display.strip().strip('"'), Uri.parse(uri_text), parse_params(tail))
        # addr-spec: params after ';' belong to the header, not the URI
        uri_text, sep, tail = text.partition(";")
        return cls("", Uri.parse(uri_text), parse_params(sep + tail))

    def __str__(self):
        disp = '"%s" ' % self.display if self.display else ""
        return "%s<%s>%s" % (disp, self.uri, format_params(self.params))


class Via:
    def __init__(self, transport, host, port, params):
        self.transport, self.host, self.port, self.params = transport, host, port, params

    @classmethod
    def parse(cls, text):
        m = re.match(r"^SIP/2\.0/(\w+)\s+(\[[^\]]+\]|[^:;\s]+)(?::(\d+))?\s*((?:;.*)?)$", text.strip(), re.S)
        if not m:
            raise SipError("bad Via: %r" % text)
        proto, host, port, params = m.groups()
        return cls(proto.lower(), host.strip("[]"), int(port) if port else None, parse_params(params))

    def __str__(self):
        host = "[%s]" % self.host if ":" in self.host else self.host
        s = "SIP/2.0/%s %s" % (self.transport.upper(), host)
        if self.port:
            s += ":%d" % self.port
        return s + format_params(self.params)


class SipMessage:
    def __init__(self):
        self.is_request = True
        self.method = self.uri = None
        self.status = 0
        self.reason = ""
        self.headers = []  # [name, value] in wire order, names canonicalised
        self.body = b""

    # -- parsing
    @classmethod
    def parse(cls, data):
        if b"\r\n\r\n" in data:
            head, body = data.split(b"\r\n\r\n", 1)
        elif b"\n\n" in data:
            head, body = data.split(b"\n\n", 1)
        else:
            head, body = data, b""
        lines = head.decode("utf-8", "replace").replace("\r\n", "\n").split("\n")
        msg = cls()
        start = lines[0].strip()
        if start.startswith("SIP/2.0 "):
            parts = start.split(" ", 2)
            if len(parts) < 2 or not parts[1].isdigit():
                raise SipError("bad status line: %r" % start)
            msg.is_request = False
            msg.status = int(parts[1])
            msg.reason = parts[2] if len(parts) > 2 else ""
        else:
            parts = start.split()
            if len(parts) != 3 or parts[2] != "SIP/2.0":
                raise SipError("bad request line: %r" % start)
            msg.method, msg.uri = parts[0].upper(), parts[1]
        unfolded = []
        for line in lines[1:]:
            if not line.strip():
                continue
            if line[0] in " \t" and unfolded:
                unfolded[-1] += " " + line.strip()
            else:
                unfolded.append(line)
        for line in unfolded:
            if ":" not in line:
                raise SipError("bad header line: %r" % line)
            name, value = line.split(":", 1)
            name = name.strip()
            name = COMPACT.get(name.lower(), name) if len(name) == 1 else canonical(name)
            msg.headers.append([name, value.strip()])
        cl = msg.get("Content-Length")
        if cl is not None and cl.strip().isdigit():
            body = body[:int(cl)]
        msg.body = body
        if msg.is_request and msg.get("Via") is None:
            raise SipError("request without Via")
        for required in ("From", "To", "Call-ID", "CSeq"):
            if msg.get(required) is None:
                raise SipError("missing %s" % required)
        return msg

    # -- header access
    def get(self, name):
        name = canonical(name)
        for n, v in self.headers:
            if n == name:
                return v
        return None

    def get_all(self, name):
        name = canonical(name)
        return [v for n, v in self.headers if n == name]

    def values(self, name):
        """All comma separated values of a header, in order."""
        out = []
        for v in self.get_all(name):
            out.extend(split_values(v))
        return out

    def set(self, name, value):
        name = canonical(name)
        self.remove(name)
        self.headers.append([name, str(value)])

    def add(self, name, value):
        self.headers.append([canonical(name), str(value)])

    def remove(self, name):
        name = canonical(name)
        self.headers = [h for h in self.headers if h[0] != name]

    def push_top(self, name, value):
        """Insert a value as the first instance of a (possibly multi-valued) header."""
        name = canonical(name)
        for i, h in enumerate(self.headers):
            if h[0] == name:
                self.headers.insert(i, [name, str(value)])
                return
        # keep Via near the top for readability
        self.headers.insert(0, [name, str(value)])

    def pop_top(self, name):
        """Remove and return the first value of a multi-valued header."""
        name = canonical(name)
        for i, h in enumerate(self.headers):
            if h[0] == name:
                vals = split_values(h[1])
                top = vals[0]
                if len(vals) > 1:
                    h[1] = ", ".join(vals[1:])
                else:
                    del self.headers[i]
                return top
        return None

    def replace_top(self, name, value):
        name = canonical(name)
        for h in self.headers:
            if h[0] == name:
                vals = split_values(h[1])
                vals[0] = str(value)
                h[1] = ", ".join(vals)
                return

    # -- convenience
    @property
    def call_id(self):
        return self.get("Call-ID")

    @property
    def cseq(self):
        parts = (self.get("CSeq") or "").split()
        if len(parts) != 2 or not parts[0].isdigit():
            raise SipError("bad CSeq")
        return int(parts[0]), parts[1].upper()

    @property
    def start_line(self):
        if self.is_request:
            return "%s %s SIP/2.0" % (self.method, self.uri)
        return "SIP/2.0 %d %s" % (self.status, self.reason)

    def summary(self):
        if self.is_request:
            return "%s %s" % (self.method, self.uri)
        return "%d %s (%s)" % (self.status, self.reason, self.cseq[1])

    def serialize(self):
        self.set("Content-Length", len(self.body))
        head = self.start_line + "\r\n" + "".join("%s: %s\r\n" % (n, v) for n, v in self.headers)
        return head.encode("utf-8") + b"\r\n" + self.body


def canonical(name):
    """Canonical header capitalisation: call-id -> Call-ID, cseq -> CSeq."""
    lower = name.lower()
    special = {"call-id": "Call-ID", "cseq": "CSeq", "www-authenticate": "WWW-Authenticate",
               "mime-version": "MIME-Version", "p-asserted-identity": "P-Asserted-Identity",
               "rack": "RAck", "rseq": "RSeq"}
    if lower in special:
        return special[lower]
    return "-".join(p[:1].upper() + p[1:] for p in lower.split("-"))


def parse_digest(value):
    """'Digest a="b", c=d' -> dict."""
    if not value or not value.lower().startswith("digest"):
        return None
    params = {}
    for m in re.finditer(r'([a-zA-Z0-9_-]+)\s*=\s*("([^"]*)"|[^,]*)', value[6:]):
        params[m.group(1).lower()] = m.group(3) if m.group(3) is not None else m.group(2).strip()
    return params


def md5(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def new_tag():
    return secrets.token_hex(5)


def new_branch():
    return "z9hG4bK" + secrets.token_hex(8)


def sip_date():
    return formatdate(usegmt=True)


# ---------------------------------------------------------------- transports

class Conn:
    """One TCP or TLS connection (accepted or outgoing)."""
    def __init__(self, sock, transport, peer):
        self.sock, self.transport, self.peer = sock, transport, peer
        self.lock = threading.Lock()
        self.alive = True

    def send(self, data):
        with self.lock:
            self.sock.sendall(data)

    def close(self):
        self.alive = False
        try:
            self.sock.close()
        except OSError:
            pass

    def __repr__(self):
        return "%s %s:%d" % (self.transport.upper(), self.peer[0], self.peer[1])


class Transports:
    def __init__(self, server):
        self.server = server
        self.conns = {}  # (transport, peer) -> Conn
        self.lock = threading.Lock()
        self.udp = None
        self.tcp_listener = None
        self.tls_listener = None
        self.tls_server_ctx = None
        self.tls_client_ctx = None

    # -- setup
    def listen(self, bind, port, tls_port, cert, key):
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.udp.bind((bind, port))
        self.tcp_listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.tcp_listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.tcp_listener.bind((bind, port))
        self.tcp_listener.listen(16)
        if tls_port:
            self.tls_server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            self.tls_server_ctx.load_cert_chain(cert, key)
            self.tls_client_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            self.tls_client_ctx.check_hostname = False
            self.tls_client_ctx.verify_mode = ssl.CERT_NONE
            self.tls_listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.tls_listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.tls_listener.bind((bind, tls_port))
            self.tls_listener.listen(16)

    def close(self):
        for s in (self.udp, self.tcp_listener, self.tls_listener):
            if s:
                try:
                    s.close()
                except OSError:
                    pass
        with self.lock:
            conns = list(self.conns.values())
        for c in conns:
            c.close()

    # -- main receive loop (runs in the main thread so Ctrl-C works)
    def serve_forever(self):
        listeners = [s for s in (self.udp, self.tcp_listener, self.tls_listener) if s]
        while True:
            readable, _, _ = select.select(listeners, [], [], 1.0)
            if self.server.dump_requested:
                self.server.dump_requested = False
                self.server.dump_state()
            for s in readable:
                if s is self.udp:
                    try:
                        data, peer = self.udp.recvfrom(65535)
                    except OSError as e:
                        log("udp recv error: %s" % e)
                        continue
                    self.server.on_data(data, "udp", peer, None)
                else:
                    transport = "tls" if s is self.tls_listener else "tcp"
                    try:
                        sock, peer = s.accept()
                    except OSError as e:
                        log("%s accept error: %s" % (transport, e))
                        continue
                    threading.Thread(target=self._reader_thread, args=(sock, transport, peer, True),
                                     daemon=True).start()

    def _reader_thread(self, sock, transport, peer, accepted):
        conn = None
        try:
            if transport == "tls" and accepted:
                sock = self.tls_server_ctx.wrap_socket(sock, server_side=True)
            conn = Conn(sock, transport, peer)
            with self.lock:
                self.conns[(transport, peer)] = conn
            if VERBOSE:
                log("%s connection %s (%s)" % (transport.upper(), "%s:%d" % peer,
                                               "accepted" if accepted else "opened"))
            self._read_loop(conn)
        except ssl.SSLError as e:
            log("%s handshake failed with %s:%d: %s" % (transport.upper(), peer[0], peer[1], e))
        except OSError as e:
            if conn and conn.alive:
                log("%s connection %s:%d error: %s" % (transport.upper(), peer[0], peer[1], e))
        finally:
            if conn:
                conn.close()
                with self.lock:
                    self.conns.pop((transport, peer), None)
            else:
                try:
                    sock.close()
                except OSError:
                    pass
            if VERBOSE:
                log("%s connection %s:%d closed" % (transport.upper(), peer[0], peer[1]))

    def _read_loop(self, conn):
        buf = b""
        while conn.alive:
            data = conn.sock.recv(65535)
            if not data:
                break
            buf += data
            while True:
                buf = buf.lstrip(b"\r\n")
                if not buf:
                    break
                end = buf.find(b"\r\n\r\n")
                if end < 0:
                    if len(buf) > 1 << 20:
                        log("%r: oversized message without header end, dropping buffer" % conn)
                        buf = b""
                    break
                m = re.search(rb"\r\n(?:Content-Length|l)\s*:\s*(\d+)", buf[:end + 2], re.I)
                length = int(m.group(1)) if m else 0
                total = end + 4 + length
                if len(buf) < total:
                    break
                frame, buf = buf[:total], buf[total:]
                self.server.on_data(frame, conn.transport, conn.peer, conn)

    # -- sending
    def find_conn(self, transport, host, port):
        with self.lock:
            return self.conns.get((transport, (host, port)))

    def connect(self, transport, host, port):
        sock = socket.create_connection((host, port), timeout=3)
        sock.settimeout(None)
        if transport == "tls":
            if not self.tls_client_ctx:
                raise SipError("TLS not enabled")
            sock = self.tls_client_ctx.wrap_socket(sock, server_hostname=host)
        peer = sock.getpeername()[:2]
        conn = Conn(sock, transport, peer)
        with self.lock:
            self.conns[(transport, peer)] = conn
        threading.Thread(target=self._read_existing, args=(conn,), daemon=True).start()
        if VERBOSE:
            log("%s connection %s:%d opened" % (transport.upper(), peer[0], peer[1]))
        return conn

    def _read_existing(self, conn):
        try:
            self._read_loop(conn)
        except OSError as e:
            if conn.alive:
                log("%r error: %s" % (conn, e))
        finally:
            conn.close()
            with self.lock:
                self.conns.pop((conn.transport, conn.peer), None)

    def send(self, data, transport, host, port, flow=None):
        """Send raw bytes. `flow` is a preferred existing Conn (may be dead)."""
        transport = (transport or "udp").lower()
        if transport == "udp":
            self.udp.sendto(data, (host, port))
            log_message("-->", "udp", (host, port), data)
            return
        conn = flow if (flow and flow.alive and flow.transport == transport) else None
        if conn is None:
            conn = self.find_conn(transport, host, port)
        if conn is None or not conn.alive:
            conn = self.connect(transport, host, port)
        conn.send(data)
        log_message("-->", transport, conn.peer, data)


def ensure_certs():
    """Create a self-signed certificate with the openssl CLI on first run."""
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    os.makedirs(CERT_DIR, exist_ok=True)
    cmd = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
           "-out", cert, "-days", "3650", "-subj", "/CN=sipper.test",
           "-addext", "subjectAltName=DNS:sipper.test,DNS:localhost,IP:127.0.0.1"]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except (OSError, subprocess.CalledProcessError) as e:
        raise SystemExit("could not generate TLS certificate with openssl: %s" % e)
    log("generated self-signed TLS certificate in %s" % CERT_DIR)
    return cert, key


# ---------------------------------------------------------------- server

class Binding:
    def __init__(self, uri, params, expires_at, flow, transport, peer):
        self.uri, self.params, self.expires_at = uri, params, expires_at
        self.flow, self.transport, self.peer = flow, transport, peer

    def as_dict(self):
        return {"contact": str(self.uri), "expires_in": max(0, int(self.expires_at - time.time())),
                "transport": self.transport, "source": "%s:%d" % self.peer}


class Server:
    def __init__(self, args):
        self.domain = args.domain.lower()
        self.port = args.port
        self.tls_port = args.tls_port
        self.advertise = args.advertise
        self.users = args.users            # user -> password
        self.mwi = args.mwi                # user -> (new, old)
        self.auth_invite = args.auth_invite
        self.answer_special = args.answer_special
        self.bindings = {}                 # user -> [Binding]
        self.nonces = {}                   # nonce -> created
        self.local_calls = {}              # Call-ID -> dict (special-number calls handled here)
        self.lock = threading.RLock()
        self.dump_requested = False
        self.transports = Transports(self)

    # -- identity helpers
    def is_me(self, uri):
        """Does this URI (Route / Request-URI) point at the proxy itself?"""
        host = uri.host.lower()
        if host not in (self.domain, self.advertise, "127.0.0.1", "localhost", socket.gethostname().lower()):
            return False
        port = uri.port or (5061 if uri.scheme == "sips" else 5060)
        return port in (self.port, self.tls_port) or uri.port is None and host == self.domain

    def is_my_domain(self, uri):
        host = uri.host.lower()
        return host == self.domain or (host in (self.advertise, "127.0.0.1", "localhost")
                                       and (uri.port in (None, self.port, self.tls_port)))

    def my_addr(self, transport):
        return self.advertise, (self.tls_port if transport == "tls" else self.port)

    def my_uri(self, transport, user=None, lr=False):
        host, port = self.my_addr(transport)
        params = ""
        if transport != "udp":
            params += ";transport=%s" % transport
        if lr:
            params += ";lr"
        return "sip:%s%s:%d%s" % ((user + "@") if user else "", host, port, params)

    def my_via(self, transport, branch):
        host, port = self.my_addr(transport)
        return "SIP/2.0/%s %s:%d;branch=%s" % (transport.upper(), host, port, branch)

    # -- entry point for every received frame
    def on_data(self, data, transport, peer, conn):
        if not data.strip(b"\r\n"):
            return  # keep-alive
        log_message("<--", transport, peer, data)
        try:
            msg = SipMessage.parse(data)
        except (SipError, ValueError, IndexError) as e:
            log("dropped malformed packet from %s %s:%d: %s" % (transport.upper(), peer[0], peer[1], e))
            return
        try:
            if msg.is_request:
                self.handle_request(msg, transport, peer, conn)
            else:
                self.handle_response(msg, transport, peer, conn)
        except SipError as e:
            log("dropped %s from %s:%d: %s" % (msg.summary(), peer[0], peer[1], e))
        except Exception as e:  # never die on a bad packet
            log("error handling %s from %s:%d: %s: %s" % (msg.summary(), peer[0], peer[1],
                                                         type(e).__name__, e))

    # -- sending helpers
    def send_to(self, msg, transport, host, port, flow=None):
        try:
            self.transports.send(msg.serialize(), transport, host, port, flow)
        except (OSError, SipError) as e:
            log("send %s to %s %s:%d failed: %s" % (msg.summary(), transport.upper(), host, port, e))

    def reply(self, req, status, transport, peer, conn, headers=(), body=b"", content_type=None, to_tag=None):
        """Build a response to `req` and send it straight back to where it came from."""
        resp = SipMessage()
        resp.is_request = False
        resp.status, resp.reason = status, REASONS.get(status, "Unknown")
        for n, v in req.headers:
            if n in ("Via", "From", "Call-ID", "CSeq"):
                resp.headers.append([n, v])
            elif n == "To":
                if status != 100 and ";tag=" not in v.lower():
                    v = v + ";tag=" + (to_tag or new_tag())
                resp.headers.append([n, v])
        if status != 100:
            for n, v in req.headers:
                if n == "Record-Route":
                    resp.headers.append([n, v])
        for n, v in headers:
            resp.add(n, v)
        resp.add("Server", SERVER_NAME)
        if content_type:
            resp.set("Content-Type", content_type)
        resp.body = body
        self.send_to(resp, transport, peer[0], peer[1], conn)
        return resp

    # -- digest auth
    def new_nonce(self):
        nonce = secrets.token_hex(16)
        now = time.time()
        with self.lock:
            self.nonces[nonce] = now
            if len(self.nonces) > 1000:
                for n, t in list(self.nonces.items()):
                    if now - t > NONCE_LIFETIME:
                        del self.nonces[n]
        return nonce

    def challenge(self, req, transport, peer, conn, proxy, stale=False):
        status = 407 if proxy else 401
        header = "Proxy-Authenticate" if proxy else "WWW-Authenticate"
        value = 'Digest realm="%s", nonce="%s", algorithm=MD5, qop="auth"' % (self.domain, self.new_nonce())
        if stale:
            value += ", stale=true"
        self.reply(req, status, transport, peer, conn, [(header, value)])

    def check_auth(self, req, transport, peer, conn, proxy):
        """Returns the authenticated username, or None after sending a 401/407/403."""
        header = "Proxy-Authorization" if proxy else "Authorization"
        creds = None
        for value in req.get_all(header):
            d = parse_digest(value)
            if d and d.get("realm", self.domain).lower() == self.domain:
                creds = d
        if not creds:
            self.challenge(req, transport, peer, conn, proxy)
            return None
        user = creds.get("username", "")
        if user not in self.users:
            log("%s from %s:%d: unknown auth user %r -> 403" % (req.method, peer[0], peer[1], user))
            self.reply(req, 403, transport, peer, conn)
            return None
        nonce = creds.get("nonce", "")
        with self.lock:
            created = self.nonces.get(nonce)
        if created is None or time.time() - created > NONCE_LIFETIME:
            self.challenge(req, transport, peer, conn, proxy, stale=True)
            return None
        ha1 = md5("%s:%s:%s" % (user, self.domain, self.users[user]))
        ha2 = md5("%s:%s" % (req.method, creds.get("uri", "")))
        qop = creds.get("qop")
        if qop:
            expected = md5("%s:%s:%s:%s:%s:%s" % (ha1, nonce, creds.get("nc", ""), creds.get("cnonce", ""), qop, ha2))
        else:
            expected = md5("%s:%s:%s" % (ha1, nonce, ha2))
        if expected != creds.get("response", "").lower():
            log("%s from %s:%d: wrong password for %s -> %d" % (req.method, peer[0], peer[1], user, 407 if proxy else 401))
            self.challenge(req, transport, peer, conn, proxy)
            return None
        return user

    # -- REGISTER
    def handle_register(self, req, transport, peer, conn):
        to = NameAddr.parse(req.get("To"))
        aor = (to.uri.user or "").lower()
        if aor not in self.users:
            log("REGISTER %s from %s:%d -> 403 (unknown user)" % (aor or "?", peer[0], peer[1]))
            self.reply(req, 403, transport, peer, conn)
            return
        if self.check_auth(req, transport, peer, conn, proxy=False) is None:
            return
        now = time.time()
        default_expires = req.get("Expires")
        default_expires = int(default_expires) if default_expires and default_expires.isdigit() else DEFAULT_EXPIRES
        contacts = req.values("Contact")
        with self.lock:
            current = [b for b in self.bindings.get(aor, []) if b.expires_at > now]
            if contacts == ["*"]:
                if default_expires == 0:
                    current = []
                    log("REGISTER %s: removed all bindings" % aor)
            else:
                for c in contacts:
                    na = NameAddr.parse(c)
                    exp = na.params.get("expires")
                    exp = int(exp) if exp and exp.isdigit() else default_expires
                    key = str(na.uri).lower()
                    current = [b for b in current if str(b.uri).lower() != key]
                    if exp > 0:
                        current.append(Binding(na.uri, na.params, now + exp, conn, transport, peer))
                        log("REGISTER %s -> 200 (%s via %s %s:%d, expires %d)" % (
                            aor, na.uri, transport.upper(), peer[0], peer[1], exp))
                    else:
                        log("REGISTER %s -> 200 (removed %s)" % (aor, na.uri))
            self.bindings[aor] = current
        headers = []
        min_exp = None
        for b in current:
            left = int(b.expires_at - now)
            headers.append(("Contact", "<%s>;expires=%d" % (b.uri, left)))
            min_exp = left if min_exp is None else min(min_exp, left)
        headers.append(("Expires", str(min_exp if min_exp is not None else 0)))
        headers.append(("Date", sip_date()))
        self.reply(req, 200, transport, peer, conn, headers)
        if aor in self.mwi and current:
            self.send_mwi_notify(aor, current[-1])

    # -- request dispatch
    def handle_request(self, req, transport, peer, conn):
        # RFC 3581 / 3261 18.2.1: record where the request really came from
        via = Via.parse(req.values("Via")[0])
        if via.host != peer[0]:
            via.params["received"] = peer[0]
        if "rport" in via.params:
            via.params["rport"] = str(peer[1])
            if "received" not in via.params:
                via.params["received"] = peer[0]
        req.replace_top("Via", str(via))

        method = req.method
        uri = Uri.parse(req.uri)

        # loose routing: strip Route headers that point at us
        while req.get("Route"):
            route = NameAddr.parse(req.values("Route")[0])
            if self.is_me(route.uri):
                req.pop_top("Route")
            else:
                break

        if method == "REGISTER":
            self.handle_register(req, transport, peer, conn)
            return

        if req.call_id in self.local_calls:
            self.handle_local_call(req, transport, peer, conn)
            return

        if method == "OPTIONS" and (not uri.user or uri.user.lower() == self.domain) and self.is_my_domain(uri):
            log("OPTIONS to server from %s:%d -> 200" % peer)
            self.reply(req, 200, transport, peer, conn,
                       [("Allow", ", ".join(ALLOW_METHODS)), ("Accept", "application/sdp"),
                        ("Supported", "replaces")])
            return

        if method not in PROXIED_METHODS:
            self.reply(req, 501, transport, peer, conn, [("Allow", ", ".join(ALLOW_METHODS))])
            return

        if self.auth_invite and method not in ("ACK", "CANCEL"):
            if self.check_auth(req, transport, peer, conn, proxy=True) is None:
                return

        if method == "INVITE" and uri.user in SPECIAL_NUMBERS and self.is_my_domain(uri):
            self.handle_special_invite(req, uri, transport, peer, conn)
            return

        if method == "SUBSCRIBE" and (req.get("Event") or "").lower().startswith("message-summary"):
            self.handle_mwi_subscribe(req, transport, peer, conn)
            return

        mf = req.get("Max-Forwards")
        mf = int(mf) if mf and mf.isdigit() else 70
        if mf <= 0:
            self.reply(req, 483, transport, peer, conn)
            return
        req.set("Max-Forwards", mf - 1)

        # where to?
        if req.get("Route"):
            target = NameAddr.parse(req.values("Route")[0]).uri
            flow = None
        elif self.is_my_domain(uri) and uri.user:
            user = uri.user.lower()
            if user not in self.users:
                if method == "ACK":
                    return  # e.g. ACK for a 4xx we sent to a special number
                log("%s to %s from %s:%d -> 404" % (method, user, peer[0], peer[1]))
                self.reply(req, 404, transport, peer, conn)
                return
            binding = self.lookup(user)
            if binding is None:
                log("%s to %s from %s:%d -> 480 (not registered)" % (method, user, peer[0], peer[1]))
                if method != "ACK":
                    self.reply(req, 480, transport, peer, conn)
                return
            target, flow = binding.uri, binding.flow
            req.uri = str(binding.uri)
        else:
            target = uri
            flow = self.flow_for(uri)
        self.forward_request(req, target, flow, transport, peer)

    def lookup(self, user):
        now = time.time()
        with self.lock:
            live = [b for b in self.bindings.get(user, []) if b.expires_at > now]
            self.bindings[user] = live
        return live[-1] if live else None

    def flow_for(self, uri):
        """Find the registration flow whose contact matches `uri` (for TLS/TCP reuse)."""
        with self.lock:
            for blist in self.bindings.values():
                for b in blist:
                    if b.uri.host == uri.host and (b.uri.port or 5060) == (uri.port or 5060) and b.flow and b.flow.alive:
                        return b.flow
        return None

    def forward_request(self, req, target, flow, in_transport, peer):
        out_transport = target.transport
        if flow and flow.alive:
            out_transport = flow.transport
        elif out_transport in ("tcp", "tls") and not flow:
            existing = self.transports.find_conn(out_transport, target.host, target.port or 5060)
            flow = existing
        in_via = Via.parse(req.values("Via")[0])
        seed = "%s|%s|%s" % (in_via.params.get("branch", secrets.token_hex(8)), req.call_id, req.cseq[0])
        branch = "z9hG4bK" + md5(seed)[:24]
        req.push_top("Via", self.my_via(out_transport, branch))
        if req.method in ("INVITE", "SUBSCRIBE", "REFER"):
            # double Record-Route when the two legs use different transports
            req.push_top("Record-Route", "<%s>" % self.my_uri(in_transport, lr=True))
            if out_transport != in_transport:
                req.push_top("Record-Route", "<%s>" % self.my_uri(out_transport, lr=True))
        host = self.advertise if target.host.lower() == self.domain else target.host
        port = target.port or (5061 if out_transport == "tls" else 5060)
        frm = NameAddr.parse(req.get("From")).uri.user or "?"
        log("%s %s -> %s: forwarding to %s %s:%d%s" % (
            req.method, frm, Uri.parse(req.uri).user or Uri.parse(req.uri).host, out_transport.upper(),
            host, port, " (existing flow)" if flow and flow.alive else ""))
        self.send_to(req, out_transport, host, port, flow)

    # -- responses: strip our Via, forward to the next one
    def handle_response(self, resp, transport, peer, conn):
        vias = resp.values("Via")
        top = Via.parse(vias[0])
        host, port = self.my_addr(top.transport)
        if (top.host, top.port or 5060) != (host, port):
            raise SipError("top Via %s is not ours" % vias[0])
        resp.pop_top("Via")
        if len(vias) == 1:
            self.handle_own_response(resp, transport, peer, conn)
            return
        nxt = Via.parse(vias[1])
        dest_host = nxt.params.get("received") or nxt.host
        rport = nxt.params.get("rport")
        dest_port = int(rport) if rport and rport.isdigit() else (nxt.port or 5060)
        flow = self.transports.find_conn(nxt.transport, dest_host, dest_port)
        if flow is None and nxt.transport in ("tcp", "tls"):
            flow = self.transports.find_conn(nxt.transport, nxt.host, nxt.port or 5060)
        if resp.status != 100:
            log("%s: relaying to %s %s:%d" % (resp.summary(), nxt.transport.upper(), dest_host, dest_port))
        self.send_to(resp, nxt.transport, dest_host, dest_port, flow)

    def handle_own_response(self, resp, transport, peer, conn):
        cseq = resp.cseq
        if resp.status >= 200 and resp.status != 100:
            log("%d %s to our %s from %s:%d" % (resp.status, resp.reason, cseq[1], peer[0], peer[1]))
        # an authenticated retry of our own requests is not needed for a test tool

    # -- state dump (signal handler only sets a flag; the main loop prints)
    def request_dump(self, *_):
        self.dump_requested = True

    def dump_state(self):
        now = time.time()
        with self.lock:
            state = {user: [b.as_dict() for b in bl if b.expires_at > now]
                     for user, bl in self.bindings.items()}
            calls = [cid for cid, c in self.local_calls.items() if c["expires"] > now]
        with LOG_LOCK:
            sys.stdout.write(json.dumps({"bindings": state, "local_calls": calls}, indent=2) + "\n")
            sys.stdout.flush()

    # -- outgoing requests generated by the server itself
    def build_request(self, method, req_uri, from_hdr, to_hdr, call_id, cseq, transport, headers=(),
                      body=b"", content_type=None):
        req = SipMessage()
        req.method, req.uri = method, str(req_uri)
        req.add("Via", self.my_via(transport, new_branch()))
        req.add("Max-Forwards", "70")
        req.add("From", from_hdr)
        req.add("To", to_hdr)
        req.add("Call-ID", call_id)
        req.add("CSeq", "%d %s" % (cseq, method))
        req.add("Contact", "<%s>" % self.my_uri(transport))
        req.add("User-Agent", SERVER_NAME)
        for n, v in headers:
            req.add(n, v)
        if content_type:
            req.add("Content-Type", content_type)
        req.body = body
        return req

    # -- MWI
    def mwi_body(self, user):
        new, old = self.mwi.get(user, (0, 0))
        return ("Messages-Waiting: %s\r\nVoice-Message: %d/%d (0/0)\r\n" % (
            "yes" if new else "no", new, old)).encode("utf-8")

    def send_mwi_notify(self, user, binding):
        aor = "sip:%s@%s" % (user, self.domain)
        req = self.build_request(
            "NOTIFY", binding.uri, "<%s>;tag=%s" % (aor, new_tag()), "<%s>" % aor,
            secrets.token_hex(12) + "@" + self.advertise, 1, binding.transport,
            [("Event", "message-summary"), ("Subscription-State", "active")],
            self.mwi_body(user), "application/simple-message-summary")
        log("NOTIFY (unsolicited MWI %d/%d) -> %s at %s %s:%d" % (
            self.mwi[user][0], self.mwi[user][1], user, binding.transport.upper(), binding.peer[0], binding.peer[1]))
        self.send_to_binding(req, binding)

    def send_to_binding(self, req, binding):
        if binding.transport == "udp":
            self.send_to(req, "udp", binding.peer[0], binding.peer[1])
        else:
            self.send_to(req, binding.transport, binding.uri.host, binding.uri.port or 5060, binding.flow)

    def handle_mwi_subscribe(self, req, transport, peer, conn):
        to = NameAddr.parse(req.get("To"))
        user = (to.uri.user or "").lower()
        expires = req.get("Expires")
        expires = int(expires) if expires and expires.isdigit() else 3600
        to_tag = to.params.get("tag") or new_tag()
        log("SUBSCRIBE message-summary from %s (%s:%d) -> 200 + NOTIFY (expires %d)" % (user, peer[0], peer[1], expires))
        self.reply(req, 200, transport, peer, conn,
                   [("Expires", str(expires)), ("Contact", "<%s>" % self.my_uri(transport))], to_tag=to_tag)
        contact = req.get("Contact")
        target = NameAddr.parse(contact).uri if contact else NameAddr.parse(req.get("From")).uri
        state = "active;expires=%d" % expires if expires > 0 else "terminated;reason=timeout"
        from_hdr = req.get("To") if ";tag=" in req.get("To").lower() else "%s;tag=%s" % (req.get("To"), to_tag)
        notify = self.build_request(
            "NOTIFY", target, from_hdr, req.get("From"), req.call_id, random.randint(1, 1000), transport,
            [("Event", "message-summary"), ("Subscription-State", state)],
            self.mwi_body(user), "application/simple-message-summary")
        if transport == "udp":
            self.send_to(notify, "udp", peer[0], peer[1])
        else:
            self.send_to(notify, transport, target.host, target.port or 5060, conn)

    # -- special numbers (*97, *echo) answered by the server itself
    def handle_special_invite(self, req, uri, transport, peer, conn):
        now = time.time()
        with self.lock:
            for cid, call in list(self.local_calls.items()):
                if call["expires"] < now:
                    del self.local_calls[cid]
        number = uri.user
        frm = NameAddr.parse(req.get("From")).uri.user or "?"
        if not self.answer_special:
            log("INVITE %s -> %s: 486 Busy Here (use --answer-special to answer)" % (frm, number))
            with self.lock:
                self.local_calls[req.call_id] = {"state": "rejected", "expires": now + 64, "timers": []}
            self.reply(req, 486, transport, peer, conn)
            return
        contact = req.get("Contact")
        call = {"state": "ringing", "expires": now + 3600, "req": req, "to_tag": new_tag(),
                "transport": transport, "peer": peer, "conn": conn, "number": number, "timers": [],
                "contact": NameAddr.parse(contact).uri if contact else NameAddr.parse(req.get("From")).uri,
                "sdp": self.make_sdp()}
        with self.lock:
            self.local_calls[req.call_id] = call
        log("INVITE %s -> %s: answering locally (180, 200, BYE after 3s)" % (frm, number))
        self.reply(req, 100, transport, peer, conn)
        self.reply(req, 180, transport, peer, conn, to_tag=call["to_tag"])
        t = threading.Timer(0.7, self.special_answer, args=(req.call_id,))
        call["timers"].append(t)
        t.start()

    def make_sdp(self):
        port = random.randrange(20000, 30000, 2)
        sess = int(time.time())
        return ("v=0\r\no=- %d %d IN IP4 127.0.0.1\r\ns=sipper-test\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n"
                "m=audio %d RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n" % (sess, sess, port)).encode()

    def special_answer(self, call_id):
        with self.lock:
            call = self.local_calls.get(call_id)
            if not call or call["state"] != "ringing":
                return
            call["state"] = "answered"
        req = call["req"]
        log("%s: 200 OK with SDP -> %s" % (call["number"], NameAddr.parse(req.get("From")).uri.user))
        self.reply(req, 200, call["transport"], call["peer"], call["conn"],
                   [("Contact", "<%s>" % self.my_uri(call["transport"], user=call["number"])),
                    ("Allow", ", ".join(ALLOW_METHODS))],
                   call["sdp"], "application/sdp", to_tag=call["to_tag"])
        t = threading.Timer(3.0, self.special_hangup, args=(call_id,))
        call["timers"].append(t)
        t.start()

    def special_hangup(self, call_id):
        with self.lock:
            call = self.local_calls.get(call_id)
            if not call or call["state"] not in ("answered", "confirmed"):
                return
            call["state"] = "bye-sent"
            call["expires"] = time.time() + 64
        req = call["req"]
        to = req.get("To")
        from_hdr = to if ";tag=" in to.lower() else "%s;tag=%s" % (to, call["to_tag"])
        bye = self.build_request("BYE", call["contact"], from_hdr, req.get("From"), call_id, 1, call["transport"])
        log("%s: sending BYE -> %s" % (call["number"], NameAddr.parse(req.get("From")).uri.user))
        self.send_to(bye, call["transport"], call["peer"][0], call["peer"][1], call["conn"])

    def handle_local_call(self, req, transport, peer, conn):
        with self.lock:
            call = self.local_calls.get(req.call_id)
        method = req.method
        if method == "ACK":
            if call.get("state") == "answered":
                call["state"] = "confirmed"
                log("%s: ACK received, call confirmed" % call["number"])
            return
        if method == "BYE":
            for t in call.get("timers", ()):
                t.cancel()
            log("%s: BYE from client -> 200, call ended" % call.get("number", "?"))
            with self.lock:
                self.local_calls.pop(req.call_id, None)
            self.reply(req, 200, transport, peer, conn)
            return
        if method == "CANCEL":
            self.reply(req, 200, transport, peer, conn)
            if call.get("state") == "ringing":
                for t in call["timers"]:
                    t.cancel()
                call["state"] = "cancelled"
                call["expires"] = time.time() + 64
                log("%s: CANCEL -> 200, INVITE -> 487" % call["number"])
                self.reply(call["req"], 487, call["transport"], call["peer"], call["conn"], to_tag=call["to_tag"])
            return
        if method == "INVITE":
            state = call.get("state")
            if state == "ringing":
                self.reply(req, 180, transport, peer, conn, to_tag=call["to_tag"])
            elif state in ("answered", "confirmed"):
                self.reply(req, 200, transport, peer, conn,
                           [("Contact", "<%s>" % self.my_uri(transport, user=call["number"]))],
                           call["sdp"], "application/sdp", to_tag=call["to_tag"])
            else:
                self.reply(req, 481, transport, peer, conn)
            return
        self.reply(req, 200, transport, peer, conn)


# ---------------------------------------------------------------- main

def parse_users(args):
    users = {}
    if args.users_file:
        with open(args.users_file) as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            users.update({str(k): str(v) for k, v in data.items()})
        else:
            for entry in data:
                users[str(entry["user"])] = str(entry["password"])
    for spec in args.user or ():
        if ":" not in spec:
            raise SystemExit("--user expects USER:PASSWORD, got %r" % spec)
        u, p = spec.split(":", 1)
        users[u] = p
    if not users:
        raise SystemExit("no users configured (use --user 1001:secret or --users-file)")
    return users


def parse_mwi(specs):
    mwi = {}
    for spec in specs or ():
        m = re.match(r"^([^:]+):(\d+)/(\d+)$", spec)
        if not m:
            raise SystemExit("--mwi expects USER:NEW/OLD, got %r" % spec)
        mwi[m.group(1)] = (int(m.group(2)), int(m.group(3)))
    return mwi


def main(argv=None):
    global VERBOSE
    ap = argparse.ArgumentParser(description="Local SIP registrar/proxy for softphone testing (stdlib only).")
    ap.add_argument("--domain", default="sipper.test", help="SIP domain / digest realm (default sipper.test)")
    ap.add_argument("--port", type=int, default=5070, help="UDP+TCP listen port (default 5070)")
    ap.add_argument("--tls-port", type=int, default=5071, help="TLS listen port, 0 disables (default 5071)")
    ap.add_argument("--bind", default="0.0.0.0", help="address to bind (default 0.0.0.0)")
    ap.add_argument("--advertise", default="127.0.0.1",
                    help="IP written into Via/Record-Route/Contact (default 127.0.0.1)")
    ap.add_argument("--user", action="append", metavar="USER:PASSWORD", help="add a user (repeatable)")
    ap.add_argument("--users-file", metavar="users.json", help='{"1001": "secret"} or [{"user":..,"password":..}]')
    ap.add_argument("--auth-invite", action="store_true", help="challenge non-REGISTER requests with 407")
    ap.add_argument("--answer-special", action="store_true",
                    help="answer *97/*echo with 180, 200 OK (PCMU SDP) and BYE after 3s instead of 486")
    ap.add_argument("--mwi", action="append", metavar="USER:NEW/OLD",
                    help="send message-summary NOTIFY after REGISTER/SUBSCRIBE (repeatable)")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every SIP message")
    args = ap.parse_args(argv)

    VERBOSE = args.verbose
    args.users = parse_users(args)
    args.mwi = parse_mwi(args.mwi)
    if args.tls_port and args.tls_port == args.port:
        raise SystemExit("--tls-port must differ from --port")

    cert = key = None
    if args.tls_port:
        cert, key = ensure_certs()

    server = Server(args)
    try:
        server.transports.listen(args.bind, args.port, args.tls_port or 0, cert, key)
    except OSError as e:
        raise SystemExit("cannot listen on %s:%d: %s" % (args.bind, args.port, e))

    for signame in ("SIGUSR1", "SIGINFO"):
        signum = getattr(signal, signame, None)
        if signum is not None:
            signal.signal(signum, server.request_dump)
    # a server started in the background from a non-interactive shell inherits SIGINT=ignore
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    log("%s listening on %s:%d (UDP/TCP)%s, domain %s, users: %s%s%s" % (
        SERVER_NAME, args.bind, args.port,
        " and :%d (TLS)" % args.tls_port if args.tls_port else "", args.domain,
        ", ".join(sorted(args.users)),
        ", proxy auth on" if args.auth_invite else "",
        ", special numbers answered" if args.answer_special else ""))
    log("send SIGUSR1%s to print the binding table as JSON; Ctrl-C to stop" % (
        " or SIGINFO (Ctrl-T)" if hasattr(signal, "SIGINFO") else ""))
    try:
        server.transports.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        server.transports.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
