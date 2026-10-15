"""Loopback-only HTTP adapter. Reuses the unchanged central device authenticator."""
import argparse
import json
import os
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from ai_media_points import APP, PREFIX, PointsError, Settlement

MAX_BODY = 16384
PUBLIC = frozenset(('balance', 'transactions', 'redeem'))
INTERNAL = frozenset(('issue-code', 'reserve', 'commit', 'release'))


def build_handler(settlement):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'AIMLPoints/1'

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            # Do not log request bodies, headers, URLs or arbitrary exception text.
            pass

        def reply(self, status, data):
            raw = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == PREFIX + 'health':
                self.reply(200, {'ok': True, 'app_name': APP, 'consumption_enabled': settlement.consumption_enabled})
            else:
                self.reply(404, {'ok': False, 'error_code': 'UNKNOWN_ENDPOINT'})

        def do_POST(self):
            if urlsplit(self.path).query:
                self.reply(400, {'ok': False, 'error_code': 'QUERY_NOT_ALLOWED'})
                return
            action = self.path.removeprefix(PREFIX)
            if self.path == PREFIX + action and action in PUBLIC:
                pass
            elif self.path == PREFIX + action and action.startswith('internal/') and action[9:] in INTERNAL:
                action = action[9:]
            else:
                self.reply(404, {'ok': False, 'error_code': 'UNKNOWN_ENDPOINT'})
                return
            try:
                if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
                    raise PointsError('INVALID_BODY_LENGTH', '请求长度无效')
                size = int(self.headers['Content-Length'])
                if not 0 < size <= MAX_BODY:
                    raise PointsError('BODY_TOO_LARGE', '请求体超出限制', 413)
                if self.headers.get_content_type() != 'application/json':
                    raise PointsError('INVALID_CONTENT_TYPE', '请求必须为JSON', 415)
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise PointsError('INCOMPLETE_BODY', '请求体不完整')
                def pairs(items):
                    result = {}
                    for key, value in items:
                        if key in result:
                            raise ValueError('duplicate key')
                        result[key] = value
                    return result
                data = json.loads(raw, object_pairs_hook=pairs)
                result = settlement.handle(action, data, self.headers)
                self.reply(200, result)
            except PointsError as exc:
                self.reply(exc.status, {'ok': False, 'app_name': APP, 'error_code': exc.code, 'message': str(exc)})
            except (ValueError, UnicodeError):
                self.reply(400, {'ok': False, 'error_code': 'INVALID_JSON', 'message': '请求格式无效'})
            except (socket.timeout, TimeoutError):
                self.reply(408, {'ok': False, 'error_code': 'REQUEST_TIMEOUT'})
            except Exception as exc:
                # Preserve safe central auth codes, never its raw exception text.
                status = getattr(exc, 'status', 500)
                if status not in (401, 403):
                    status = 500
                self.reply(status, {'ok': False, 'error_code': 'DEVICE_AUTH_FAILED' if status in (401, 403) else 'SETTLEMENT_UNAVAILABLE',
                                    'message': '设备授权校验失败' if status in (401, 403) else '积分服务暂时不可用'})
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--initialize', action='store_true')
    args = parser.parse_args()
    root = Path(os.environ.get('AIML_LICENSE_SERVER_ROOT', '/opt/original-video-dedup-tool/server'))
    sys.path.insert(0, str(root))
    import license_server
    if not license_server.DB_PATH.is_file():
        raise RuntimeError('Central database is missing')
    token_path = Path(os.environ.get('AIML_POINTS_INTERNAL_TOKEN_FILE', '/etc/ai-media-library/points-internal.token'))
    token = token_path.read_text().strip() if token_path.is_file() else ''
    if len(token) < 32:
        raise RuntimeError('Media settlement internal token is not configured')
    engine = Settlement(license_server.DB_PATH, license_server._device_auth, token,
                        os.environ.get('AIML_POINTS_CONSUMPTION_ENABLED') == '1')
    if args.initialize:
        engine.initialize()
        print(json.dumps({'ok': True, 'app_name': APP, 'initialized': True}))
        return
    # Schema is explicitly initialized after backup, never lazily by a public request.
    with engine.transaction() as conn:
        conn.execute('SELECT 1 FROM aiml_point_wallets LIMIT 1')
    server = ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('AIML_POINTS_PORT', '8842'))), build_handler(engine))
    server.serve_forever()


if __name__ == '__main__':
    main()
