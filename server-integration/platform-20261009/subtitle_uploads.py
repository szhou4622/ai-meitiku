"""Authenticated, streamed private MP4 uploads. No provider calls or points.

Files expire after 24 hours; quotes contain an account-bound opaque reference,
never a local path, public URL or base64 copy of a potentially 1GB video.
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from ai_media_tasks import TaskError

LIMIT = 1024 ** 3  # VIAPI official 1GB input limit, same as customer-API mode.
CHUNK = 1024 ** 2


class SubtitleUploads:
    def __init__(self, directory, key, probe, clock=time.time):
        self.root, self.cipher, self.probe, self.clock = Path(directory), AESGCM(key), probe, clock
        self.gate = threading.BoundedSemaphore(1)
        self.root.mkdir(parents=True, mode=0o700, exist_ok=True)

    def metadata(self, upload_id):
        if not isinstance(upload_id, str) or not re.fullmatch(r'[a-f0-9]{48}', upload_id):
            raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
        try:
            raw = (self.root / (upload_id + '.bin')).read_bytes()
            return json.loads(self.cipher.decrypt(raw[:12], raw[12:], ('subtitle-upload:' + upload_id).encode()))
        except FileNotFoundError:
            raise TaskError('SUBTITLE_UPLOAD_EXPIRED', 409) from None

    def resolve(self, upload_id, account):
        item = self.metadata(upload_id)
        if item['account'] != account:
            raise TaskError('SUBTITLE_UPLOAD_DENIED', 403)
        file = self.root / (upload_id + '.mp4')
        if item['expires_at'] < self.clock() or not file.is_file() or file.is_symlink() or file.stat().st_size != item['size']:
            raise TaskError('SUBTITLE_UPLOAD_EXPIRED', 409)
        return file, item

    def expire(self):
        # Only private temporary uploads; never touches customer source files.
        for file in self.root.glob('*.bin'):
            item = self.metadata(file.stem)
            if item['expires_at'] < self.clock():
                (self.root / (file.stem + '.mp4')).unlink(missing_ok=True)
                file.unlink(missing_ok=True)

    def receive(self, stream, size, account):
        if type(size) is not int or not 0 < size <= LIMIT:
            raise TaskError('SUBTITLE_FILE_TOO_LARGE', 413)
        if not self.gate.acquire(blocking=False):
            raise TaskError('SUBTITLE_UPLOAD_BUSY', 503)
        upload_id = secrets.token_hex(24)
        partial, final = self.root / (upload_id + '.part'), self.root / (upload_id + '.mp4')
        try:
            self.expire()
            if shutil.disk_usage(self.root).free < size + 2 * LIMIT:
                raise TaskError('SUBTITLE_STORAGE_BUSY', 503)
            digest, remaining = hashlib.sha256(), size
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output:
                while remaining:
                    chunk = stream.read(min(CHUNK, remaining))
                    if not chunk:
                        raise TaskError('SUBTITLE_UPLOAD_INCOMPLETE', 400)
                    digest.update(chunk); output.write(chunk); remaining -= len(chunk)
                output.flush(); os.fsync(output.fileno())
            seconds = self.probe(partial)
            os.replace(partial, final)
            item = {'account': account, 'size': size, 'sha256': digest.hexdigest(),
                    'seconds': seconds, 'expires_at': self.clock() + 86400}
            nonce = os.urandom(12)
            raw = nonce + self.cipher.encrypt(nonce, json.dumps(item).encode(), ('subtitle-upload:' + upload_id).encode())
            fd = os.open(self.root / (upload_id + '.bin'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output:
                output.write(raw); output.flush(); os.fsync(output.fileno())
            return {'upload_id': upload_id, 'size_bytes': size, 'sha256': item['sha256'], 'verified_seconds': seconds}
        except Exception:
            partial.unlink(missing_ok=True); final.unlink(missing_ok=True)
            (self.root / (upload_id + '.bin')).unlink(missing_ok=True)
            raise
        finally:
            self.gate.release()
