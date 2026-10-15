"""Media-only durable recovery. Never submits a provider generation operation."""
import json
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, build_opener
from ai_media_tasks import TaskError
from minimax_platform import NoRedirect

TERMINAL = {'source-expired', 'abandoned'}


def progress(adapter, quote_id, **values):
    state = adapter.checkpoint(quote_id) or {}
    state.update(values, updated_at=time.time())
    adapter.checkpoint(quote_id, state)
    return state


def retryable(adapter, quote_id):
    state = adapter.checkpoint(quote_id) or {}
    return bool(state.get('job_id') and state.get('phase') not in TERMINAL
                and state.get('retry_at', 0) <= time.time())


def public_progress(adapter, quote_id):
    state = adapter.checkpoint(quote_id) or {}
    # Only an allowlist escapes the encrypted checkpoint. Never expose source URLs.
    return {key: state[key] for key in ('phase', 'received_bytes', 'total_bytes', 'attempts',
            'last_error', 'retry_at', 'updated_at') if key in state}


def recover_failure(adapter, quote_id, exc):
    state = adapter.checkpoint(quote_id) or {}
    if state.get('phase') in TERMINAL: return
    attempt = state.get('attempts', 0) + 1
    code = getattr(exc, 'code', None)
    if not isinstance(code, str):
        if isinstance(exc, HTTPError): code = 'SUBTITLE_HTTP_' + str(exc.code)
        elif isinstance(exc, TimeoutError): code = 'SUBTITLE_TRANSFER_TIMEOUT'
        elif isinstance(exc, PermissionError): code = 'SUBTITLE_STORAGE_PERMISSION'
        elif isinstance(exc, ImportError): code = 'SUBTITLE_COMPONENT_MISSING'
        else: code = 'SUBTITLE_TRANSFER_INTERRUPTED'
    print(json.dumps({'event': 'subtitle-transfer-retry', 'quote_id': quote_id,
        'phase': state.get('phase'), 'error_type': type(exc).__name__, 'error_code': code,
        'errno': getattr(exc, 'errno', None)}), flush=True)
    progress(adapter, quote_id, attempts=attempt, last_error=code,
             retry_at=time.time() + min(60, 2 ** min(attempt, 6)))


def retrieve(adapter, quote_id, url, opener=None):
    """Keep partial and fully fetched bytes across retries and process restarts."""
    from aliyun_platform import safe_url, LIMIT
    opener = opener or build_opener(NoRedirect())
    directory = adapter.state_dir / 'downloads'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    part, ready = directory / (quote_id + '.part'), directory / (quote_id + '.source.mp4')
    state = adapter.checkpoint(quote_id) or {}
    orphan = adapter.results.file(quote_id, '.mp4')
    if not ready.exists() and orphan.exists() and not adapter.results.read(quote_id): ready = orphan
    if not ready.exists():
        expires = parse_qs(urlparse(url).query).get('Expires', [None])[0]
        if expires and float(expires) <= time.time():
            progress(adapter, quote_id, phase='source-expired', last_error='SUBTITLE_SOURCE_EXPIRED')
            raise TaskError('SUBTITLE_SOURCE_EXPIRED', 410)
        progress(adapter, quote_id, phase='retrieving', source_url=url, retry_at=0)
        offset = part.stat().st_size if part.exists() else 0
        headers = {'Range': f'bytes={offset}-'} if offset else {}
        try:
            response = opener.open(Request(safe_url(url), headers=headers), timeout=30)
        except HTTPError as exc:
            if exc.code == 403:
                body = exc.read(16384)
                if b'Request has expired' in body:
                    progress(adapter, quote_id, phase='source-expired', last_error='SUBTITLE_SOURCE_EXPIRED')
                    raise TaskError('SUBTITLE_SOURCE_EXPIRED', 410) from None
            raise
        with response:
            resumed = offset and response.status == 206
            if resumed:
                import re
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                if not match or int(match[1]) != offset:
                    raise TaskError('SUBTITLE_RESULT_UNVERIFIED', 503)
                total = int(match[3])
            else:
                offset = 0
                total = int(response.headers.get('Content-Length', 0))
            received, started, last = offset, time.monotonic(), 0
            with part.open('ab' if resumed else 'wb') as output:
                part.chmod(0o600)
                while chunk := response.read(256 * 1024):
                    received += len(chunk)
                    if received > 2 * LIMIT: raise TaskError('SUPPLIER_VIDEO_UNVERIFIED', 503)
                    output.write(chunk)
                    if time.monotonic() - last > 1:
                        output.flush()
                        progress(adapter, quote_id, received_bytes=received, total_bytes=total)
                        last = time.monotonic()
                    if time.monotonic() - started > 300: raise TimeoutError('bounded retrieval attempt')
                output.flush()
                import os
                os.fsync(output.fileno())
            if not received or (total and total != received):
                raise TaskError('SUBTITLE_TRANSFER_INCOMPLETE', 503)
            part.replace(ready)
            progress(adapter, quote_id, phase='verifying', received_bytes=received, total_bytes=received)
    seconds = adapter.probe(ready)
    progress(adapter, quote_id, phase='storing', retry_at=0)
    adapter.results.preserve(quote_id, ready, seconds)
    result = adapter.results.public(quote_id)
    progress(adapter, quote_id, phase='ready', last_error='', retry_at=0, source_url=None)
    return result, seconds


class SubtitleRecoveryWorker:
    def __init__(self, tasks, interval=5):
        self.tasks, self.interval = tasks, interval
        self.stop_event = threading.Event()
        self.thread = None

    def scan(self):
        # Read-only enumeration; the existing status transaction claims each job once.
        import sqlite3
        with sqlite3.connect('file:' + self.tasks.db_path + '?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute("SELECT quote_id,account_id,spec FROM aiml_generation_tasks WHERE status='unknown' ORDER BY created_at DESC").fetchall()
        for row in rows:
            try:
                spec = self.tasks.unseal(row['spec'])
                if spec.get('feature') != 'subtitle-removal' or spec.get('provider') != 'aliyun': continue
                self.tasks.status(row['quote_id'], row['account_id'])
            except Exception:
                print(json.dumps({'event': 'subtitle-recovery-job-retry', 'quote_id': row['quote_id']}), flush=True)

    def start(self):
        def run():
            while not self.stop_event.is_set():
                try: self.scan()
                except Exception:
                    # No credentials or payloads in logs. Keep scanning after DB/network failures.
                    print(json.dumps({'event': 'subtitle-recovery-scan-retry'}), flush=True)
                self.stop_event.wait(self.interval)
        self.thread = threading.Thread(target=run, daemon=True, name='subtitle-recovery')
        self.thread.start()
        return self

    def stop(self):
        self.stop_event.set()
