"""
serve.py — Zero-dependency test server for TextWatcher.

Serves the tests/ folder at http://localhost:8080/
Open http://localhost:8080/test-page.html in Chrome after loading the extension.

Usage:
    python tests/serve.py
    # or from inside tests/:
    python serve.py
"""
import http.server, socketserver, os, webbrowser, threading, pathlib

PORT = 8080
ROOT = pathlib.Path(__file__).parent          # serves the tests/ folder

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)
    def log_message(self, fmt, *args):        # suppress request noise
        pass

def open_browser():
    import time; time.sleep(0.5)
    webbrowser.open(f"http://localhost:{PORT}/test-page.html")

threading.Thread(target=open_browser, daemon=True).start()

print(f"TextWatcher test server running at http://localhost:{PORT}/test-page.html")
print("Press Ctrl+C to stop.\n")

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.allow_reuse_address = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
