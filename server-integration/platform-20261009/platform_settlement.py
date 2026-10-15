"""Media-only loopback bridge; the internal settlement token never leaves the server."""
import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from ai_media_tasks import APP, TaskError


class LoopbackSettlement:
    def __init__(self, internal_token):
        if not isinstance(internal_token, str) or len(internal_token) < 32:
            raise ValueError('missing private settlement token')
        self.internal_token = internal_token

    def __call__(self, action, data, device_headers):
        if action not in ('reserve', 'commit', 'release') or data.get('app_name') != APP:
            raise TaskError('INVALID_INTERNAL_SETTLEMENT', 403)
        headers = {'Content-Type': 'application/json', 'X-AIML-Settlement-Token': self.internal_token}
        # Never forward arbitrary client headers or accept its internal token.
        for name in ('Authorization', 'X-Device-Credential'):
            value = device_headers.get(name)
            if value:
                headers[name] = value
        request = Request('http://127.0.0.1:8842/api/license/ai-media-library/points/internal/' + action,
                          data=json.dumps(data).encode(), headers=headers, method='POST')
        try:
            response = urlopen(request, timeout=12)
        except HTTPError as exc:
            response = exc
        with response:
            result = json.loads(response.read(65536))
            if response.status != 200 or result.get('ok') is not True or result.get('app_name') != APP:
                code = result.get('error_code', 'SETTLEMENT_UNAVAILABLE')
                raise TaskError(code if isinstance(code, str) and code.isascii() and len(code) <= 80 else 'SETTLEMENT_UNAVAILABLE',
                                response.status if response.status in (400, 401, 402, 403, 404, 409) else 503)
            return result
