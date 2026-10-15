"""Seed 2.1 Lite standard inference: server pricing and trusted token usage.

Official pricing https://docs.volcengine.com/docs/ark/model-pricing?lang=zh
Input/cache/output CNY per million: 0.80 / 0.16 / 2.70.
Default high-detail images use 1280 tokens in Seed 2.0 and newer models.
Quote text conservatively by UTF-8 bytes; settle the provider's actual tokens.
No client budget, arbitrary points cap, web search, tools or audio billing.
"""
import base64
import copy
import json
import re
from decimal import Decimal
from urllib.request import Request, build_opener
from urllib.error import HTTPError
from ai_media_tasks import TaskError, NoChargeFailure, fingerprint
from minimax_platform import NoRedirect

MODEL = 'doubao-seed-2-1-lite-260915'
PRICE_VERSION = 'seed-2.1-lite-usage-20261014'


def token_cost(prompt, completion, cached=0):
    if any(type(v) is not int or v < 0 for v in (prompt, completion, cached)) or cached > prompt:
        raise TaskError('SUPPLIER_USAGE_UNVERIFIED', 503)
    return format(((prompt - cached) * Decimal('0.80') + cached * Decimal('0.16')
                   + completion * Decimal('2.70')) / Decimal(1000000), '.8f')


class SeedLite:
    def __init__(self, api_key, endpoint_id=MODEL, request=None, allow_images=True):
        self.api_key, self.endpoint_id, self.request = api_key, endpoint_id, request or self.http
        self.allow_images = allow_images
        # The confirmed model identity is frozen with each quote. Provider keys
        # stay private; changing endpoint/key invalidates unconfirmed old quotes.
        self.configuration = fingerprint({'model': MODEL, 'endpoint': endpoint_id, 'key': api_key, 'price': PRICE_VERSION})

    def quote(self, feature, payload, account):
        if feature not in ('schemes', 'classifier', 'prompt-library') or not isinstance(payload, dict):
            raise TaskError('INVALID_CHAT_REQUEST', 400)
        if set(payload) - {'messages', 'max_tokens', 'temperature', 'response_format'} or 'messages' not in payload:
            raise TaskError('INVALID_CHAT_REQUEST', 400)
        body = copy.deepcopy(payload)
        messages = body['messages']
        output = body.get('max_tokens', 4096)
        temperature = body.get('temperature', 0.2)
        if (not isinstance(messages, list) or not 1 <= len(messages) <= 128
                or type(output) is not int or not 1 <= output <= 16000
                or type(temperature) not in (int, float) or not 0 <= temperature <= 2):
            raise TaskError('INVALID_CHAT_REQUEST', 400)
        if body.get('response_format') not in (None, {'type': 'json_object'}):
            raise TaskError('INVALID_CHAT_REQUEST', 400)
        input_bound = 32
        images = 0
        for message in messages:
            if (not isinstance(message, dict) or set(message) != {'role', 'content'}
                    or message['role'] not in ('system', 'user', 'assistant')):
                raise TaskError('INVALID_CHAT_REQUEST', 400)
            input_bound += 32
            content = message['content']
            if isinstance(content, str):
                input_bound += len(content.encode())
                continue
            if not isinstance(content, list) or not 1 <= len(content) <= 256:
                raise TaskError('INVALID_CHAT_REQUEST', 400)
            for part in content:
                if not isinstance(part, dict):
                    raise TaskError('INVALID_CHAT_REQUEST', 400)
                if part.get('type') == 'text' and set(part) == {'type', 'text'} and isinstance(part['text'], str):
                    input_bound += len(part['text'].encode())
                elif part.get('type') == 'image_url' and set(part) == {'type', 'image_url'}:
                    if not self.allow_images:
                        raise TaskError('PLATFORM_TEXT_ONLY', 400)
                    image = part['image_url']
                    if not isinstance(image, dict) or set(image) != {'url'} or not isinstance(image['url'], str):
                        raise TaskError('INVALID_CHAT_IMAGE', 400)
                    match = re.fullmatch(r'data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)', image['url'])
                    try:
                        if not match or not 1 <= len(base64.b64decode(match[2], validate=True)) <= 10 * 1024 * 1024:
                            raise ValueError()
                    except Exception:
                        raise TaskError('INVALID_CHAT_IMAGE', 400) from None
                    image['detail'] = 'high'
                    images += 1
                    input_bound += 1280 + 32
                else:
                    raise TaskError('INVALID_CHAT_REQUEST', 400)
        if images > 64 or input_bound + output > 1024000:
            raise TaskError('CHAT_CONTEXT_TOO_LARGE', 400)
        body.update(model=self.endpoint_id, max_tokens=output, temperature=temperature,
                    stream=False, thinking={'type': 'disabled'})
        return {'display_cny': token_cost(input_bound, output), 'pricing_kind': 'estimate',
                'price_version': PRICE_VERSION, 'model': MODEL, 'payload': body,
                'configuration': self.configuration, 'billing_basis': 'supplier_usage_tariff'}

    def confirmed_usage_cost(self, spec, result, receipt, quote_id):
        # Private policy migration verifies the original authenticated receipt;
        # neither model nor cost can come from a client's migration request.
        if (spec['price_version'] not in ('seed-2.1-lite-standard-20261009', PRICE_VERSION)
                or spec['model'] != MODEL or result.get('model') != MODEL
                or receipt.get('billed_model') != MODEL or result.get('id') != receipt.get('bill_ref')):
            raise TaskError('SUPPLIER_RECEIPT_UNVERIFIED', 503)
        usage = result.get('usage', {})
        prompt, completion, total = (usage.get(k) for k in ('prompt_tokens', 'completion_tokens', 'total_tokens'))
        cached = usage.get('prompt_tokens_details', {}).get('cached_tokens', 0)
        charged = token_cost(prompt, completion, cached)
        if type(total) is not int or total != prompt + completion or charged != receipt.get('standard_tariff_cny'):
            raise TaskError('SUPPLIER_USAGE_UNVERIFIED', 503)
        return charged

    def http(self, body):
        req = Request('https://ark.cn-beijing.volces.com/api/v3/chat/completions',
                      data=json.dumps(body).encode(), method='POST',
                      headers={'Authorization': 'Bearer ' + self.api_key, 'Content-Type': 'application/json'})
        try:
            response = build_opener(NoRedirect()).open(req, timeout=180)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise TaskError('SUPPLIER_RESPONSE_UNVERIFIED', 503)
            return response.status, json.loads(raw)

    def execute(self, spec, account, quote_id):
        status, response = self.request(spec['payload'])
        if (status in (401, 403) and isinstance(response, dict)
                and isinstance(response.get('error'), dict) and not response.get('usage')
                and not response.get('choices')):
            # Explicit authentication/authorization rejection cannot have
            # produced inference. Release this reservation without retrying.
            raise NoChargeFailure()
        if status != 200 or not isinstance(response, dict) or 'error' in response:
            # Unverified failures are never assumed to be free or retried here.
            raise TaskError('SUPPLIER_OUTCOME_UNVERIFIED', 503)
        if response.get('model') not in (MODEL, self.endpoint_id):
            raise TaskError('SUPPLIER_MODEL_UNVERIFIED', 503)
        usage = response.get('usage', {})
        prompt, completion, total = (usage.get(k) for k in ('prompt_tokens', 'completion_tokens', 'total_tokens'))
        cached = usage.get('prompt_tokens_details', {}).get('cached_tokens', 0)
        charged = token_cost(prompt, completion, cached)
        if type(total) is not int or total != prompt + completion:
            raise TaskError('SUPPLIER_USAGE_UNVERIFIED', 503)
        bill = response.get('id')
        choices = response.get('choices')
        if not isinstance(bill, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', bill) or not isinstance(choices, list) or not choices:
            raise TaskError('SUPPLIER_RECEIPT_UNVERIFIED', 503)
        # Return the compatible result fields, never arbitrary supplier headers,
        # URLs, keys, debug messages or provider-side secret metadata.
        safe_choices = []
        for choice in choices:
            message = choice.get('message', {})
            if not isinstance(message.get('content'), str):
                raise TaskError('SUPPLIER_RESULT_UNVERIFIED', 503)
            safe_choices.append({'message': {'role': 'assistant', 'content': message['content']},
                                 'finish_reason': choice.get('finish_reason')})
        result = {'id': bill, 'model': MODEL, 'choices': safe_choices,
                  'usage': {'prompt_tokens': prompt, 'completion_tokens': completion, 'total_tokens': total,
                            'prompt_tokens_details': {'cached_tokens': cached}}}
        return result, {'standard_tariff_cny': charged, 'supplier_debit_cny': None, 'bill_ref': bill, 'billed_model': MODEL}
