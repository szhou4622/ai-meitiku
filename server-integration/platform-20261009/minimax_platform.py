"""Server-side MiniMax clone-preview adapter. It never activates an ongoing TTS voice.

Pricing: https://platform.minimax.cn/docs/guides/pricing-paygo
Only the preview synthesis is charged here. The 9.90 CNY first formal synthesis
fee does not apply to the clone endpoint's preview and must not be added.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import unicodedata
from pathlib import Path
from decimal import Decimal
from urllib.error import HTTPError
import time
from urllib.parse import urlparse
from urllib.request import Request, HTTPRedirectHandler, build_opener

from ai_media_tasks import TaskError, NoChargeFailure, fingerprint

PRICE_VERSION = 'minimax-paygo-20261013-usage'
RATES = {'speech-2.8-turbo': Decimal('2.00'), 'speech-2.8-hd': Decimal('3.50'),
         'speech-2.6-turbo': Decimal('2.00'), 'speech-2.6-hd': Decimal('3.50')}
MIMES = {'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
         'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a'}


def characters(text):
    # Chinese characters count twice; other characters count once. Use UTF-16
    # units for supplementary symbols so the quote does not undercount them.
    return sum(2 if unicodedata.name(char, '').startswith(('CJK UNIFIED', 'CJK COMPATIBILITY'))
               else len(char.encode('utf-16-le')) // 2 for char in text)


def cost(count, model):
    if type(count) is not int or not 0 <= count <= 100000 or model not in RATES:
        raise TaskError('SUPPLIER_USAGE_UNVERIFIED', 503)
    return format(Decimal(count) * RATES[model] / Decimal(10000), '.8f')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class MiniMaxPreview:
    def __init__(self, api_key, request=None, key=None, state_dir=None):
        self.api_key = api_key
        self.request = request or self.http
        self.key, self.state_dir = key, Path(state_dir) if state_dir else None
        self.configuration = fingerprint({'version': PRICE_VERSION, 'rates': {k: str(v) for k, v in RATES.items()},
                                          'key_hash': hashlib.sha256(api_key.encode()).hexdigest()})

    def quote(self, feature, payload, account):
        if feature != 'voice' or not isinstance(payload, dict) or set(payload) != {'audio', 'previewText', 'model', 'consent'}:
            raise TaskError('INVALID_VOICE_REQUEST', 400)
        audio, text, model = payload['audio'], payload['previewText'], payload['model']
        if payload['consent'] is not True or not isinstance(text, str) or not 1 <= len(text.strip()) <= 1000 or not isinstance(model, str) or model not in RATES:
            raise TaskError('INVALID_VOICE_REQUEST', 400)
        if not isinstance(audio, str) or len(audio) > 40 * 1024 * 1024:
            raise TaskError('INVALID_VOICE_SAMPLE', 400)
        match = re.fullmatch(r'data:(audio/[a-z0-9+-]+);base64,([A-Za-z0-9+/=]+)', audio)
        if not match or match[1] not in MIMES:
            raise TaskError('INVALID_VOICE_SAMPLE', 400)
        try:
            buffer = base64.b64decode(match[2], validate=True)
        except Exception:
            raise TaskError('INVALID_VOICE_SAMPLE', 400) from None
        if not 1 <= len(buffer) <= 20 * 1024 * 1024:
            raise TaskError('INVALID_VOICE_SAMPLE', 400)
        return {'display_cny': cost(characters(text), model), 'pricing_kind': 'estimate',
                'price_version': PRICE_VERSION, 'model': model, 'payload': payload,
                'configuration': self.configuration, 'billing_basis': 'supplier_usage_tariff'}

    def http(self, path, raw, content_type):
        if path not in ('/files/upload', '/voice_clone'):
            raise ValueError('unsupported supplier operation')
        req = Request('https://api.minimax.cn/v1' + path, data=raw, method='POST',
                      headers={'Authorization': 'Bearer ' + self.api_key, 'Content-Type': content_type})
        try:
            response = build_opener(NoRedirect()).open(req, timeout=180)
        except HTTPError as exc:
            response = exc
        with response:
            raw_response = response.read(8 * 1024 * 1024 + 1)
            if len(raw_response) > 8 * 1024 * 1024:
                raise TaskError('SUPPLIER_RESPONSE_UNVERIFIED', 503)
            data = json.loads(raw_response)
            return response.status, data

    def checkpoint(self, quote_id, value=None):
        if self.state_dir is None: return None
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        if not re.fullmatch(r'[a-f0-9]{40}', quote_id): raise ValueError('invalid quote')
        file = self.state_dir / (quote_id + '.bin')
        aad = ('minimax:' + quote_id).encode()
        if value is None:
            if not file.is_file(): return None
            raw = file.read_bytes()
            return json.loads(AESGCM(self.key).decrypt(raw[:12], raw[12:], aad))
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        nonce = os.urandom(12)
        temporary = file.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(nonce + AESGCM(self.key).encrypt(nonce, json.dumps(value).encode(), aad))
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, file)

    def resumable(self, quote_id):
        state = self.checkpoint(quote_id)
        return bool(state and 'response' in state)

    def resume(self, spec, quote_id):
        state = self.checkpoint(quote_id)
        if not state or 'response' not in state:
            raise TaskError('SUPPLIER_OUTCOME_UNVERIFIED', 503)
        return self.parse_response(spec, quote_id, state['status'], state['response'])

    def execute(self, spec, account, quote_id):
        old = self.checkpoint(quote_id)
        if old:
            # A submitted request is never repeated, even after a restart.
            return self.resume(spec, quote_id)
        payload = spec['payload']
        mime, encoded = payload['audio'][5:].split(';base64,', 1)
        audio = base64.b64decode(encoded, validate=True)
        boundary = 'aiml-' + secrets.token_hex(24)
        raw = (f'--{boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nvoice_clone\r\n'
               f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.{MIMES[mime]}"\r\n'
               f'Content-Type: {mime}\r\n\r\n').encode() + audio + f'\r\n--{boundary}--\r\n'.encode()
        try:
            status, uploaded = self.request('/files/upload', raw, 'multipart/form-data; boundary=' + boundary)
            file_id = uploaded.get('file', {}).get('file_id')
            if status != 200 or uploaded.get('base_resp', {}).get('status_code') != 0 or not re.fullmatch(r'\d{1,20}', str(file_id)):
                raise ValueError('upload rejected')
        except Exception:
            # The upload is free and no clone/preview synthesis has been sent.
            raise NoChargeFailure() from None
        request = {'file_id': int(file_id), 'voice_id': 'aiml_' + quote_id, 'text': payload['previewText'],
                   'model': spec['model'], 'need_noise_reduction': True, 'need_volume_normalization': True}
        sent = {'submitted': True, 'file_id': int(file_id), 'phase': 'supplier_call', 'started_at': time.time()}
        self.checkpoint(quote_id, sent)
        try:
            status, response = self.request('/voice_clone', json.dumps(request).encode(), 'application/json')
        except Exception as exc:
            # Persist a safe cause and the fact that a paid request may have
            # reached the supplier. Never retry it, and never call it free.
            code = (exc.code if isinstance(exc, TaskError) else 'SUPPLIER_TIMEOUT' if isinstance(exc, TimeoutError)
                    else 'SUPPLIER_RESPONSE_INVALID' if isinstance(exc, (ValueError, UnicodeError)) else 'SUPPLIER_TRANSPORT_ERROR')
            self.checkpoint(quote_id, {**sent, 'phase': 'response_missing', 'error_code': code})
            raise TaskError(code, 503) from None
        # Preserve the authenticated response before validating its format. A
        # parsing fix can recover a paid result without submitting another call.
        self.checkpoint(quote_id, {**sent, 'phase': 'response_preserved', 'status': status, 'response': response})
        return self.parse_response(spec, quote_id, status, response)

    def parse_response(self, spec, quote_id, status, response):
        code = response.get('base_resp', {}).get('status_code') if isinstance(response, dict) else None
        if (code in (1004, 2013, 2038) and not response.get('demo_audio') and not response.get('extra_info')):
            raise NoChargeFailure()
        if status != 200 or response.get('base_resp', {}).get('status_code') != 0:
            raise TaskError('MINIMAX_REJECTED_' + str(code) if type(code) is int else 'SUPPLIER_OUTCOME_UNVERIFIED', 503)
        extra = response.get('extra_info', {})
        usage = extra.get('usage_characters')
        charged = cost(usage, spec['model'])
        preview = response.get('demo_audio')
        if not isinstance(preview, str) or not preview:
            raise TaskError('SUPPLIER_AUDIO_UNVERIFIED', 503)
        url = urlparse(preview)
        if (url.scheme != 'https' or url.username or url.password or url.port
                or not (url.hostname == 'minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com'
                        or any(url.hostname and url.hostname.endswith('.' + domain) for domain in ('minimax.cn', 'minimaxi.com')))):
            raise TaskError('SUPPLIER_AUDIO_UNVERIFIED', 503)
        safe_extra = {k: extra[k] for k in ('audio_length', 'audio_sample_rate', 'audio_size', 'bitrate', 'usage_characters')
                      if type(extra.get(k)) is int and extra[k] >= 0}
        result = {'demo_audio': preview, 'extra_info': safe_extra, 'base_resp': {'status_code': 0}}
        # The private task store retains this authenticated response's receipt.
        receipt_hash = fingerprint({'quote_id': quote_id, 'response': response})
        return result, {'standard_tariff_cny': charged, 'supplier_debit_cny': None, 'bill_ref': 'minimax:' + receipt_hash, 'billed_model': spec['model']}
