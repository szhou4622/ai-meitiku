"""Private, durable subtitle outputs; refreshing downloads never runs inference."""
import hashlib
import json
import os
import re
import time
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from ai_media_tasks import TaskError

RETENTION = 7 * 86400


class SubtitleResults:
    def __init__(self, directory, key, storage, clock=time.time):
        self.root, self.cipher, self.storage, self.clock = Path(directory), AESGCM(key), storage, clock
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.cleanup()

    def file(self, quote_id, suffix='.bin'):
        if not isinstance(quote_id, str) or not re.fullmatch(r'[a-f0-9]{40}', quote_id):
            raise TaskError('INVALID_QUOTE', 400)
        return self.root / (quote_id + suffix)

    def read(self, quote_id):
        try: raw = self.file(quote_id).read_bytes()
        except FileNotFoundError: return None
        return json.loads(self.cipher.decrypt(raw[:12], raw[12:], quote_id.encode()))

    def write(self, quote_id, value):
        nonce = os.urandom(12)
        temporary = self.file(quote_id, '.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(nonce + self.cipher.encrypt(nonce, json.dumps(value).encode(), quote_id.encode()))
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, self.file(quote_id))

    def preserve(self, quote_id, file, seconds):
        # Keep a local verified copy until remote persistence is confirmed.
        target = self.file(quote_id, '.mp4')
        os.replace(file, target); target.chmod(0o600)
        with target.open('rb') as stream: os.fsync(stream.fileno())
        digest = hashlib.sha256()
        with target.open('rb') as stream:
            while chunk := stream.read(1024 ** 2): digest.update(chunk)
        value = {'key': 'aiml-subtitles-temp/results/' + quote_id + '.mp4',
                 'size': target.stat().st_size, 'sha256': digest.hexdigest(), 'seconds': seconds,
                 'retained_until': self.clock() + RETENTION, 'stored': False}
        self.write(quote_id, value)
        return self.ensure(quote_id)

    def ensure(self, quote_id):
        value = self.read(quote_id)
        if not value: return None
        if value['retained_until'] <= self.clock():
            raise TaskError('SUBTITLE_RESULT_EXPIRED', 410)
        if not value['stored']:
            self.storage.upload_file(self.file(quote_id, '.mp4'), value['key'])
            if self.storage.head(value['key'])['size'] != value['size']:
                raise TaskError('SUBTITLE_RESULT_UNVERIFIED', 503)
            value['stored'] = True; self.write(quote_id, value)
            self.file(quote_id, '.mp4').unlink(missing_ok=True)
        return value

    def public(self, quote_id):
        value = self.ensure(quote_id)
        if not value: raise TaskError('SUBTITLE_RESULT_UNAVAILABLE', 503)
        expires = min(int(self.clock()) + 900, int(value['retained_until']))
        url, _ = self.storage.sign('GET', value['key'], expires=expires)
        return {'VideoUrl': url, 'download_expires_at': expires,
                'result_retained_until': value['retained_until'],
                'size_bytes': value['size'], 'sha256': value['sha256'],
                'usage': {'output_seconds': value['seconds']}}

    def cleanup(self):
        for file in self.root.glob('*.bin'):
            value = self.read(file.stem)
            if value['retained_until'] <= self.clock():
                file.unlink(); self.file(file.stem, '.mp4').unlink(missing_ok=True)
