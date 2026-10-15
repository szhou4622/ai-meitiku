"""Private account-bound multipart uploads. Only signed part PUTs leave the server.

The platform receives metadata, never the video body. Range reads reconstruct
MP4 metadata in a sparse private file for the established server-side probe.
No caller controls bucket, object key, URL, expiry, price or video duration.
"""
import base64
import email.utils
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener
from urllib.error import HTTPError
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from ai_media_tasks import TaskError
from minimax_platform import NoRedirect

PART_SIZE = 8 * 1024 ** 2
LIMIT = 1024 ** 3
PREFIX = 'aiml-subtitles-temp/'


class OssStorage:
    def __init__(self, access_key_id, secret, bucket):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', bucket):
            raise ValueError('invalid private bucket')
        self.id, self.secret, self.bucket = access_key_id, secret.encode(), bucket
        self.host = bucket + '.oss-cn-shanghai.aliyuncs.com'

    def sign(self, method, key, query=None, headers=None, expires=None):
        query, headers = dict(query or {}), {k.lower(): v for k, v in (headers or {}).items()}
        resource = '/' + self.bucket + '/' + key
        if query:
            resource += '?' + '&'.join(k + ('=' + str(v) if v != '' else '') for k, v in sorted(query.items()))
        canonical_headers = ''.join(k + ':' + str(v) + '\n' for k, v in sorted(headers.items()) if k.startswith('x-oss-'))
        date = str(expires) if expires is not None else email.utils.formatdate(usegmt=True)
        value = '\n'.join((method, headers.get('content-md5', ''), headers.get('content-type', ''), date)) + '\n' + canonical_headers + resource
        signature = base64.b64encode(hmac.new(self.secret, value.encode(), hashlib.sha1).digest()).decode()
        if expires is not None:
            query.update(OSSAccessKeyId=self.id, Expires=date, Signature=signature)
        else:
            headers.update(date=date, authorization='OSS ' + self.id + ':' + signature)
        return 'https://' + self.host + '/' + quote(key, safe='/') + ('?' + urlencode(query) if query else ''), headers

    def request(self, method, key, query=None, data=None, headers=None):
        url, signed = self.sign(method, key, query, headers)
        return build_opener(NoRedirect()).open(Request(url, data=data, headers=signed, method=method), timeout=30)

    def initiate(self, key):
        with self.request('POST', key, {'uploads': ''}, b'', {'content-type': 'video/mp4'}) as response:
            value = ET.fromstring(response.read(65536)).findtext('UploadId')
        if not value or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', value):
            raise TaskError('SUBTITLE_UPLOAD_UNVERIFIED', 503)
        return value

    def parts(self, key, upload):
        with self.request('GET', key, {'uploadId': upload}) as response:
            root = ET.fromstring(response.read(262144))
        if root.findtext('IsTruncated') == 'true':
            raise TaskError('SUBTITLE_UPLOAD_UNVERIFIED', 503)
        return [{'number': int(p.findtext('PartNumber')), 'size': int(p.findtext('Size')),
                 'etag': p.findtext('ETag').strip('"')} for p in root.findall('Part')]

    def complete(self, key, upload, parts):
        root = ET.Element('CompleteMultipartUpload')
        for part in parts:
            node = ET.SubElement(root, 'Part')
            ET.SubElement(node, 'PartNumber').text = str(part['number'])
            ET.SubElement(node, 'ETag').text = part['etag']
        with self.request('POST', key, {'uploadId': upload}, ET.tostring(root), {'content-type': 'application/xml'}) as response:
            result = ET.fromstring(response.read(65536))
        if result.tag != 'CompleteMultipartUploadResult':
            raise TaskError('SUBTITLE_UPLOAD_UNVERIFIED', 503)

    def head(self, key):
        with self.request('HEAD', key) as response:
            return {'size': int(response.headers['Content-Length']), 'etag': response.headers['ETag'].strip('"')}

    def upload_file(self, file, key):
        upload = self.initiate(key)
        parts = []
        with file.open('rb') as stream:
            while chunk := stream.read(PART_SIZE):
                number = len(parts) + 1
                digest = base64.b64encode(hashlib.md5(chunk).digest()).decode()
                with self.request('PUT', key, {'uploadId': upload, 'partNumber': number}, chunk,
                                  {'content-type': 'application/octet-stream', 'content-md5': digest}) as response:
                    parts.append({'number': number, 'etag': response.headers['ETag'].strip('"')})
        self.complete(key, upload, parts)

    def read_range(self, key, start, count, total):
        with self.request('GET', key, headers={'range': f'bytes={start}-{start+count-1}'}) as response:
            if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{start+count-1}/{total}':
                raise TaskError('SUBTITLE_UPLOAD_UNVERIFIED', 503)
            value = response.read(count+1)
        if len(value) != count: raise TaskError('SUBTITLE_UPLOAD_UNVERIFIED', 503)
        return value


class DirectSubtitleUploads:
    def __init__(self, directory, key, probe, storage, clock=time.time):
        self.root, self.cipher, self.key = Path(directory), AESGCM(key), key
        self.probe, self.storage, self.clock = probe, storage, clock
        self.lock = threading.RLock()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)

    def file(self, upload_id):
        if not isinstance(upload_id, str) or not re.fullmatch(r'[a-f0-9]{48}', upload_id):
            raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
        return self.root / (upload_id + '.bin')

    def write(self, upload_id, item):
        nonce = os.urandom(12)
        temporary = self.file(upload_id).with_suffix('.tmp')
        raw = nonce + self.cipher.encrypt(nonce, json.dumps(item).encode(), ('oss-subtitle:' + upload_id).encode())
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(raw); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, self.file(upload_id))

    def metadata(self, upload_id, account):
        try: raw = self.file(upload_id).read_bytes()
        except FileNotFoundError: raise TaskError('SUBTITLE_UPLOAD_EXPIRED', 409) from None
        item = json.loads(self.cipher.decrypt(raw[:12], raw[12:], ('oss-subtitle:' + upload_id).encode()))
        if item['account'] != account: raise TaskError('SUBTITLE_UPLOAD_DENIED', 403)
        if item['expires_at'] < self.clock(): raise TaskError('SUBTITLE_UPLOAD_EXPIRED', 409)
        return item

    def public(self, upload_id, item, parts=None):
        return {'upload_id': upload_id, 'transport': 'oss-multipart', 'size_bytes': item['size'],
                'sha256': item['sha256'], 'part_size': PART_SIZE, 'part_count': len(item['md5']),
                'completed': item['completed'], 'uploaded_parts': [p['number'] for p in (parts or [])],
                **({'verified_seconds': item['seconds'], 'metadata_read_bytes': item['metadata_read_bytes']}
                   if item['completed'] else {})}

    def init(self, body, account):
        if set(body) != {'request_id', 'size_bytes', 'sha256', 'part_md5'}:
            raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
        size, digests, request_id = body['size_bytes'], body['part_md5'], body['request_id']
        if type(size) is not int or not 0 < size <= LIMIT: raise TaskError('SUBTITLE_FILE_TOO_LARGE', 413)
        if (not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9:_.-]{1,160}', request_id)
                or not isinstance(body['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', body['sha256'])
                or not isinstance(digests, list) or len(digests) != math.ceil(size/PART_SIZE)
                or any(not isinstance(d, str) or not re.fullmatch(r'[a-f0-9]{32}', d) for d in digests)):
            raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
        upload_id = hmac.new(self.key, (str(account) + ':' + request_id).encode(), hashlib.sha256).hexdigest()[:48]
        with self.lock:
            if self.file(upload_id).exists():
                item = self.metadata(upload_id, account)
                if (item['sha256'], item['size'], item['md5']) != (body['sha256'], size, digests):
                    raise TaskError('SUBTITLE_UPLOAD_CHANGED', 409)
            else:
                active = 0
                for file in self.root.glob('*.bin'):
                    try:
                        old = self.metadata(file.stem, account)
                        active += not old['completed']
                    except TaskError: pass
                if active >= 3: raise TaskError('SUBTITLE_UPLOAD_BUSY', 503)
                item = {'account': account, 'size': size, 'sha256': body['sha256'], 'md5': digests,
                        'key': PREFIX + secrets.token_hex(24) + '.mp4', 'expires_at': self.clock()+72000,
                        'completed': False}
                item['oss_upload_id'] = self.storage.initiate(item['key'])
                self.write(upload_id, item)
            return self.public(upload_id, item)

    def verified_parts(self, item):
        parts = self.storage.parts(item['key'], item['oss_upload_id'])
        seen = set()
        for part in parts:
            n = part['number']
            if (n in seen or not 1 <= n <= len(item['md5']) or part['etag'].lower() != item['md5'][n-1]
                    or part['size'] != min(PART_SIZE, item['size']-(n-1)*PART_SIZE)):
                raise TaskError('SUBTITLE_UPLOAD_UNVERIFIED', 503)
            seen.add(n)
        return sorted(parts, key=lambda p: p['number'])

    def status(self, body, account):
        if set(body) != {'upload_id'}: raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
        with self.lock:
            item = self.metadata(body['upload_id'], account)
            if item.get('completing') and not item['completed']:
                return self.complete(body, account)
            return self.public(body['upload_id'], item, None if item['completed'] else self.verified_parts(item))

    def part(self, body, account):
        if set(body) != {'upload_id', 'part_number'}: raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
        with self.lock:
            item = self.metadata(body['upload_id'], account)
            n = body['part_number']
            if item['completed'] or type(n) is not int or not 1 <= n <= len(item['md5']):
                raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
            headers = {'content-type': 'application/octet-stream', 'content-md5': base64.b64encode(bytes.fromhex(item['md5'][n-1])).decode()}
            url, _ = self.storage.sign('PUT', item['key'], {'uploadId': item['oss_upload_id'], 'partNumber': n}, headers, int(self.clock())+900)
            return {'upload_id': body['upload_id'], 'part_number': n, 'url': url, 'headers': headers}

    def probe_metadata(self, item):
        # MP4 top-level headers let us skip mdat/free payloads without relaying
        # the video. The sparse file has the original offsets for moov parsing.
        size, offset, fetched, found = item['size'], 0, 0, set()
        with tempfile.TemporaryDirectory(prefix='aiml-oss-metadata-') as directory:
            file = Path(directory) / 'metadata.mp4'
            with file.open('wb') as output:
                file.chmod(0o600); output.truncate(size)
                for _ in range(4096):
                    if offset == size: break
                    if size-offset < 8: raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
                    header = self.storage.read_range(item['key'], offset, 8, size); fetched += 8
                    length, kind = int.from_bytes(header[:4], 'big'), header[4:8]
                    if length == 1:
                        header += self.storage.read_range(item['key'], offset+8, 8, size); fetched += 8
                        length = int.from_bytes(header[8:16], 'big')
                    elif length == 0: length = size-offset
                    if length < len(header) or offset+length > size or (offset == 0 and kind != b'ftyp'):
                        raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
                    output.seek(offset); output.write(header)
                    if kind in (b'ftyp', b'moov', b'moof'):
                        if fetched+length > 32*1024**2: raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
                        if length > len(header):
                            payload = self.storage.read_range(item['key'], offset+len(header), length-len(header), size)
                            output.write(payload); fetched += len(payload)
                        found.add(kind)
                    offset += length
                if offset != size or not {b'ftyp', b'moov'} <= found: raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
            return self.probe(file), fetched

    def complete(self, body, account):
        if set(body) != {'upload_id'}: raise TaskError('INVALID_SUBTITLE_UPLOAD', 400)
        upload_id = body['upload_id']
        with self.lock:
            item = self.metadata(upload_id, account)
            if item['completed']: return self.public(upload_id, item)
            # A lost complete response is recovered by checking the same object;
            # never create or overwrite an object to recover the old upload.
            if item.get('completing'):
                try: head = self.storage.head(item['key'])
                except HTTPError as exc:
                    if exc.code != 404: raise
                    head = None
            else: head = None
            if head is None:
                parts = self.verified_parts(item)
                if len(parts) != len(item['md5']): raise TaskError('SUBTITLE_UPLOAD_INCOMPLETE', 409)
                item['completing'] = True; self.write(upload_id, item)
                self.storage.complete(item['key'], item['oss_upload_id'], parts)
                head = self.storage.head(item['key'])
            if head['size'] != item['size']: raise TaskError('SUBTITLE_UPLOAD_UNVERIFIED', 503)
            item['seconds'], item['metadata_read_bytes'] = self.probe_metadata(item)
            item.update(completed=True, etag=head['etag'])
            self.write(upload_id, item)
            return self.public(upload_id, item)

    def resolve(self, upload_id, account):
        item = self.metadata(upload_id, account)
        if not item['completed']: raise TaskError('SUBTITLE_UPLOAD_INCOMPLETE', 409)
        return None, item

    def source_url(self, upload_id, account):
        _, item = self.resolve(upload_id, account)
        head = self.storage.head(item['key'])
        if head['size'] != item['size'] or head['etag'] != item['etag']:
            raise TaskError('SUBTITLE_UPLOAD_UNVERIFIED', 503)
        return self.storage.sign('GET', item['key'], expires=int(self.clock())+3600)[0]
