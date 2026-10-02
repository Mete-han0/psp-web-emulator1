#!/usr/bin/env python3
"""Dev server for the PPSSPP web build.

The wasm build is threaded and needs SharedArrayBuffer, which browsers only
expose to cross-origin-isolated documents. That requires two response headers,
which is why a plain static host or GitHub Pages will not work:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

Netlify (_headers) and Cloudflare Pages (_headers) can both set these, so
production deployment is straightforward. This script is only for local dev.

Usage:  python3 serve.py [port]
"""

import http.server
import os
import shutil
import socket
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
COPY_BUF = 4 * 1024 * 1024  # 4 MB; the stdlib default is 64 KB, which is a real
                           # bottleneck when serving 500 MB game images.


class Handler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 keeps the connection alive between requests. The stdlib defaults to
    # HTTP/1.0, which forces a fresh connection for every file and slows large
    # transfers noticeably.
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def setup(self):
        super().setup()
        # The stdlib leaves Nagle's algorithm on. Combined with delayed ACKs that
        # adds latency to every chunk of a large response.
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def copyfile(self, source, outputfile):
        shutil.copyfileobj(source, outputfile, COPY_BUF)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # No caching, so rebuilds show up on reload.
        self.send_header("Cache-Control", "no-store")
        # Lets the browser issue Range requests, so an interrupted download can
        # resume and large files can be fetched in parallel parts.
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    # .wasm and .data must arrive as octet-stream or some hosts mangle them.
    os.chdir(ROOT)
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"PPSSPP Web dev server: http://127.0.0.1:{PORT}/")
        print("Serving COOP/COEP headers. Ctrl-C to stop.")
        httpd.serve_forever()