#!/usr/bin/env python3
"""
Super simple HTTP server that logs ALL requests.
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json

PORT = 8095

class SimpleHandler(BaseHTTPRequestHandler):
    def log_request_details(self):
        print(f"\n{'='*60}")
        print(f"📥 {self.command} {self.path}")
        print(f"Headers:")
        for key, value in self.headers.items():
            print(f"  {key}: {value}")
        
        # Read body if present
        content_length = self.headers.get('Content-Length')
        if content_length:
            body = self.rfile.read(int(content_length))
            print(f"Body ({len(body)} bytes):")
            try:
                parsed = json.loads(body)
                print(json.dumps(parsed, indent=2))
            except:
                print(body.decode('utf-8', errors='replace')[:500])
        print(f"{'='*60}\n")
    
    def do_GET(self):
        self.log_request_details()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status": "ok"}')
    
    def do_POST(self):
        self.log_request_details()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status": "ok"}')
    
    def do_PUT(self):
        self.log_request_details()
        self.send_response(200)
        self.end_headers()
    
    def do_DELETE(self):
        self.log_request_details()
        self.send_response(200)
        self.end_headers()

if __name__ == '__main__':
    print(f"🚀 Simple HTTP server listening on http://0.0.0.0:{PORT}")
    print(f"   All requests will be logged to console")
    print(f"   Press Ctrl+C to stop\n")
    
    server = HTTPServer(('0.0.0.0', PORT), SimpleHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Server stopped")
