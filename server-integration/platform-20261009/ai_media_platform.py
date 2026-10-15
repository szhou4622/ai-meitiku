"""Media-only private vault and authenticated readiness gateway.

Prompt text execution requires an explicit deployment switch. Final settlement
waits for verified supplier billing; missing bills are never treated as zero.
"""
import base64
import argparse
import json
import os
import socket
import stat
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
sys.path.insert(0, str(Path(__file__).parent / "vendor"))
from ai_media_tasks import TaskError

APP = 'ai-media-library'
PREFIX = '/api/ai-media-library/v1/'
AAD = b'ai-media-library:platform-api:v1'
FIELDS = {'aliyun': {'accessKeyId', 'accessKeySecret'},
          'volcengine': {'endpointId', 'apiKey'}, 'minimax': {'apiKey'}}


def private_read(path, owner=0):
    """Reject links, permissive modes, wrong ownership and oversized config files."""
    path = Path(path)
    for parent in path.parents:
        if parent.is_symlink():
            raise ValueError('unsafe private path')
    parent = path.parent.stat()
    if parent.st_uid != owner or stat.S_IMODE(parent.st_mode) != 0o700:
        raise ValueError('unsafe private directory')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or info.st_size > 65536):
            raise ValueError('unsafe private file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(65537)
    finally:
        os.close(fd)


def load_vault(key_path, vault_path, owner=0):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = private_read(key_path, owner)
    envelope = json.loads(private_read(vault_path, owner))
    if (len(key) != 32 or envelope.get('schema') != 1
            or envelope.get('app_name') != APP or envelope.get('cipher') != 'AES-256-GCM'):
        raise ValueError('invalid media vault')
    iv, tag, ciphertext = [base64.b64decode(envelope[name], validate=True)
                           for name in ('iv', 'tag', 'ciphertext')]
    if len(iv) != 12 or len(tag) != 16:
        raise ValueError('invalid media envelope')
    payload = json.loads(AESGCM(key).decrypt(iv, ciphertext + tag, AAD))
    providers = payload.get('providers')
    if payload.get('app_name') != APP or not isinstance(providers, dict) or set(providers) != set(FIELDS):
        raise ValueError('invalid media providers')
    for name, fields in FIELDS.items():
        values = providers[name]
        if not isinstance(values, dict) or set(values) != fields:
            raise ValueError('invalid provider fields')
        if any(not isinstance(v, str) or not v.strip() or len(v) > 4096 for v in values.values()):
            raise ValueError('invalid provider credential')
    return providers


def central_consumption_enabled():
    """The settlement service owns the switch; unavailable/invalid state fails closed."""
    try:
        with urlopen('http://127.0.0.1:8842/api/license/ai-media-library/points/health', timeout=3) as response:
            state = json.loads(response.read(4096))
        return (state.get('ok') is True and state.get('app_name') == APP
                and state.get('consumption_enabled') is True)
    except Exception:
        return False


def build_handler(authenticate, providers, consumption_enabled=lambda: False, tasks=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'AIMLPlatform/1'

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass  # Never log bodies, headers, credentials or arbitrary exception text.

        def reply(self, status, data):
            raw = json.dumps({'app_name': APP, **data}, ensure_ascii=False).encode()
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
                self.reply(200, {'ok': True, 'generation_enabled': bool(tasks and tasks.adapters),
                                 'consumption_enabled': consumption_enabled()})
            else:
                self.reply(404, {'ok': False, 'error_code': 'UNKNOWN_ENDPOINT'})

        def do_POST(self):
            if self.path == PREFIX + 'uploads/subtitle' and tasks is not None:
                try:
                    # Authenticate before consuming any potentially large body.
                    account = tasks.identity(self.headers)
                    adapter = tasks.adapters.get('aliyun')
                    uploads = getattr(adapter, 'uploads', None)
                    if not uploads or 'subtitle-removal' not in tasks.allowed_features or not consumption_enabled():
                        raise TaskError('PLATFORM_FEATURE_UNAVAILABLE', 503)
                    lengths = self.headers.get_all('Content-Length', [])
                    if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or self.headers.get_content_type() != 'video/mp4':
                        raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
                    self.connection.settimeout(60)
                    value = uploads.receive(self.rfile, int(lengths[0]), account)
                    self.reply(200, {'ok': True, **value})
                except TaskError as exc:
                    self.reply(exc.status, {'ok': False, 'error_code': exc.code})
                except (ValueError, UnicodeError):
                    self.reply(400, {'ok': False, 'error_code': 'INVALID_SUBTITLE_UPLOAD'})
                except (socket.timeout, TimeoutError):
                    self.reply(408, {'ok': False, 'error_code': 'SUBTITLE_UPLOAD_INCOMPLETE'})
                except Exception as exc:
                    status = getattr(exc, 'status', 503)
                    status = status if status in (401, 403) else 503
                    self.reply(status, {'ok': False, 'error_code': 'DEVICE_AUTH_FAILED'
                                        if status in (401, 403) else 'SUBTITLE_UPLOAD_FAILED'})
                return
            task_action = self.path.removeprefix(PREFIX + 'tasks/') if self.path.startswith(PREFIX + 'tasks/') else None
            upload_action = self.path.removeprefix(PREFIX + 'uploads/subtitle/') if self.path.startswith(PREFIX + 'uploads/subtitle/') else None
            if self.path != PREFIX + 'capabilities' and (tasks is None or (task_action not in ('quote', 'run', 'status') and upload_action not in ('init', 'part', 'status', 'complete'))):
                self.reply(404, {'ok': False, 'error_code': 'UNKNOWN_ENDPOINT'})
                return
            try:
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') or len(lengths) != 1:
                    raise ValueError('invalid length')
                size = int(lengths[0])
                if not 0 < size <= (64 * 1024 * 1024 if task_action == 'quote' else 16384 if upload_action else 4096):
                    self.reply(413, {'ok': False, 'error_code': 'BODY_TOO_LARGE'})
                    return
                if self.headers.get_content_type() != 'application/json':
                    self.reply(415, {'ok': False, 'error_code': 'INVALID_CONTENT_TYPE'})
                    return
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise ValueError('incomplete body')
                def pairs(items):
                    result = {}
                    for key, value in items:
                        if key in result:
                            raise ValueError('duplicate key')
                        result[key] = value
                    return result
                body = json.loads(raw, object_pairs_hook=pairs)
                if not isinstance(body, dict) or body.get('app_name') != APP:
                    self.reply(403, {'ok': False, 'error_code': 'APP_SCOPE_DENIED'})
                    return
                if upload_action:
                    account = tasks.identity(self.headers)
                    uploads = getattr(tasks.adapters.get('aliyun'), 'direct_uploads', None)
                    if not uploads or 'subtitle-removal' not in tasks.allowed_features or not consumption_enabled():
                        raise TaskError('PLATFORM_FEATURE_UNAVAILABLE', 503)
                    self.connection.settimeout(120)
                    value = getattr(uploads, upload_action)({k: v for k, v in body.items() if k != 'app_name'}, account)
                    self.reply(200, {'ok': True, **value})
                    return
                if task_action:
                    self.reply(200, tasks.handle(task_action, body, self.headers))
                    return
                if set(body) != {'app_name'}:
                    raise ValueError('unexpected fields')
                identity = authenticate(self.headers, allow_expired=False)
                if identity.get('app_name') != APP:
                    self.reply(403, {'ok': False, 'error_code': 'APP_CREDENTIAL_MISMATCH'})
                    return
                # Allowlisted metadata only. Never serialize the decrypted vault.
                self.reply(200, {'ok': True, 'generation_enabled': bool(tasks and tasks.adapters), 'consumption_enabled': consumption_enabled(),
                                 'enabled_features': sorted(tasks.allowed_features) if tasks and tasks.adapters else [],
                                 'providers': {name: {'configured': True, 'validated': False}
                                               for name in FIELDS if name in providers}})
            except TaskError as exc:
                self.reply(exc.status, {'ok': False, 'error_code': exc.code})
            except (ValueError, UnicodeError):
                self.reply(400, {'ok': False, 'error_code': 'INVALID_REQUEST'})
            except (socket.timeout, TimeoutError):
                self.reply(408, {'ok': False, 'error_code': 'REQUEST_TIMEOUT'})
            except Exception as exc:
                status = getattr(exc, 'status', 500)
                status = status if status in (401, 403) else 503
                self.reply(status, {'ok': False, 'error_code': 'DEVICE_AUTH_FAILED'
                                    if status in (401, 403) else 'SERVICE_UNAVAILABLE'})
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--initialize-tasks', action='store_true')
    args = parser.parse_args()
    providers = load_vault('/etc/ai-media-library/platform-api.masterkey',
                           '/var/lib/ai-media-library/platform-api.enc.json')
    sys.path.insert(0, '/opt/original-video-dedup-tool/server')
    import license_server
    if not license_server.DB_PATH.is_file():
        raise RuntimeError('missing central database')
    # Task execution is explicitly enabled only after the media-only candidate
    # has been reviewed, backed up and deployed. Installing source alone does
    # not enable paid generation.
    tasks = None
    if args.initialize_tasks or os.environ.get('AIML_PLATFORM_GENERATION_ENABLED') == '1':
        from ai_media_tasks import MediaTasks
        from volcengine_platform import SeedLite
        from minimax_platform import MiniMaxPreview
        from aliyun_platform import AliyunSubtitles, AliyunReconciler
        from platform_settlement import LoopbackSettlement
        token = private_read('/etc/ai-media-library/points-internal.token').decode().strip()
        key = private_read('/etc/ai-media-library/platform-api.masterkey')
        tasks = MediaTasks('/var/lib/ai-media-library/generation.sqlite3', key, license_server._device_auth,
                           LoopbackSettlement(token), {
                               'volcengine': SeedLite(providers['volcengine']['apiKey'], allow_images=True),
                               'minimax': MiniMaxPreview(providers['minimax']['apiKey'], key=key, state_dir='/var/lib/ai-media-library/voice-tasks'),
                               'aliyun': AliyunSubtitles(providers['aliyun']['accessKeyId'], providers['aliyun']['accessKeySecret'], key, '/var/lib/ai-media-library/subtitle-tasks', oss_bucket=os.environ.get('AIML_SUBTITLE_OSS_BUCKET')),
                           }, central_consumption_enabled, allowed_features={'prompt-library', 'schemes', 'classifier', 'voice', 'subtitle-removal'})
        billing_path = Path('/var/lib/ai-media-library/platform-billing.enc.json')
        if billing_path.is_file():
            from volcengine_billing import load_billing_vault, VolcengineBilling
            from volcengine_reconcile import VolcengineReconciler
            billing = load_billing_vault('/etc/ai-media-library/platform-api.masterkey', billing_path)
            volcengine_reconciler = VolcengineReconciler(
                VolcengineBilling(billing['accessKeyId'], billing['accessKeySecret']), billing['apiKeyResourceId'],
                tasks.adapters['volcengine'].configuration)
            aliyun_reconciler = AliyunReconciler(tasks.adapters['aliyun'])
            def reconcile(current_tasks, quote_id):
                with current_tasks.transaction() as conn:
                    row = conn.execute('SELECT spec FROM aiml_generation_tasks WHERE quote_id=?', (quote_id,)).fetchone()
                provider = current_tasks.unseal(row['spec'])['provider'] if row else None
                if provider == 'volcengine': volcengine_reconciler(current_tasks, quote_id)
                elif provider == 'aliyun': aliyun_reconciler(current_tasks, quote_id)
            tasks.billing_resolver = reconcile
        if args.initialize_tasks:
            tasks.initialize()
            print(json.dumps({'ok': True, 'app_name': APP, 'tasks_initialized': True, 'supplier_requests': 0}))
            return
        # Initialization is a separate explicit operation after backup. A public
        # request must never create or migrate tables.
        with tasks.transaction() as conn:
            conn.execute('SELECT 1 FROM aiml_generation_tasks LIMIT 1')
        tasks.recover_pending()
        from subtitle_recovery import SubtitleRecoveryWorker
        SubtitleRecoveryWorker(tasks).start()
    ThreadingHTTPServer(('127.0.0.1', 8843), build_handler(license_server._device_auth, providers,
                                                       central_consumption_enabled, tasks)).serve_forever()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('AI media platform startup failed; inspect private configuration', file=sys.stderr)
        raise SystemExit(1)
