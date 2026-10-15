"""Private, read-only Volcengine bill queries; credentials never enter task data."""
import datetime
import hashlib
import hmac
import json
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from minimax_platform import NoRedirect
from ai_media_tasks import TaskError

HOST = 'billing.volcengineapi.com'
ACTIONS = frozenset({'ListBillDetail', 'ListSplitBillDetail'})


def load_billing_vault(key_path, vault_path, owner=0):
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from ai_media_platform import private_read, APP
    key = private_read(key_path, owner)
    envelope = json.loads(private_read(vault_path, owner))
    if len(key) != 32 or envelope.get('schema') != 1 or envelope.get('app_name') != APP or envelope.get('cipher') != 'AES-256-GCM':
        raise ValueError('invalid private billing vault')
    nonce, ciphertext, tag = [base64.b64decode(envelope[name], validate=True) for name in ('iv', 'ciphertext', 'tag')]
    if len(nonce) != 12 or len(tag) != 16:
        raise ValueError('invalid private billing envelope')
    data = json.loads(AESGCM(key).decrypt(nonce, ciphertext + tag, b'ai-media-library:platform-billing:v1'))
    if (not isinstance(data, dict) or set(data) != {'accessKeyId', 'accessKeySecret', 'apiKeyResourceId'}
            or any(not isinstance(value, str) or not value.strip() or len(value) > 4096 for value in data.values())):
        raise ValueError('invalid private billing fields')
    return data


def signed_request(access_key, secret_key, action, payload, now=None):
    if action not in ACTIONS | {'GetInferenceUsage'}:
        raise ValueError('only read-only bill queries are permitted')
    usage = action == 'GetInferenceUsage'
    host = 'ark.cn-beijing.volcengineapi.com' if usage else HOST
    region, service, version = ('cn-beijing', 'ark', '2024-01-01') if usage else ('cn-north-1', 'billing', '2022-01-01')
    now = now or datetime.datetime.now(datetime.timezone.utc)
    timestamp = now.strftime('%Y%m%dT%H%M%SZ')
    day = timestamp[:8]
    body = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode()
    body_hash = hashlib.sha256(body).hexdigest()
    headers = {'content-type': 'application/json', 'host': host,
               'x-content-sha256': body_hash, 'x-date': timestamp}
    signed = ';'.join(sorted(headers))
    canonical_headers = ''.join(key + ':' + headers[key] + '\n' for key in sorted(headers))
    query = 'Action=' + action + '&Version=' + version
    canonical = '\n'.join(['POST', '/', query, canonical_headers, signed, body_hash])
    scope = day + '/' + region + '/' + service + '/request'
    to_sign = '\n'.join(['HMAC-SHA256', timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signing_key = secret_key.encode()
    for part in (day, region, service, 'request'):
        signing_key = hmac.new(signing_key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers['Authorization'] = ('HMAC-SHA256 Credential=' + access_key + '/' + scope
                                + ', SignedHeaders=' + signed + ', Signature=' + signature)
    return Request('https://' + host + '/?' + query, data=body, headers=headers, method='POST')


class VolcengineBilling:
    def __init__(self, access_key, secret_key, open_request=None):
        self.access_key, self.secret_key = access_key, secret_key
        self.open_request = open_request or build_opener(NoRedirect()).open

    def query(self, action, payload):
        request = signed_request(self.access_key, self.secret_key, action, payload)
        try:
            try:
                response = self.open_request(request, timeout=20)
            except HTTPError as error:
                response = error
            with response:
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise TaskError('BILL_RESPONSE_TOO_LARGE', 503)
                body = json.loads(raw)
                error = body.get('ResponseMetadata', {}).get('Error')
                if error:
                    raise TaskError('BILL_PERMISSION_DENIED' if error.get('Code') == 'AccessDenied'
                                    else 'BILL_QUERY_REJECTED', 503)
                if response.status != 200 or not isinstance(body.get('Result'), dict):
                    raise TaskError('BILL_RESPONSE_UNVERIFIED', 503)
                return body['Result']
        except TaskError:
            raise
        except Exception:
            raise TaskError('BILL_QUERY_UNAVAILABLE', 503) from None
