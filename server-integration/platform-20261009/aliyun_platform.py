"""Private VIAPI EraseVideoSubtitles adapter; no customer credentials or URLs.

Official tariff: 0.4 CNY/output minute, metered in whole seconds.
Pending bills remain pending. Accepted RequestIds are encrypted before polling;
recovery queries that same job and never submits another paid operation.
"""
import base64
import io
import json
import math
import os
import re
import subprocess
import tempfile
import time
import datetime as dt
import threading
from decimal import Decimal, ROUND_UP
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, build_opener
from ai_media_tasks import TaskError, NoChargeFailure, SupplierTaskFailure, fingerprint
from minimax_platform import NoRedirect

MODEL = 'EraseVideoSubtitles'
PRICE_VERSION = 'aliyun-viapi-detext-usage-20261014-upload'
LIMIT = 1024 ** 3


def tariff(seconds):
    return format((Decimal(math.ceil(seconds)) * Decimal('0.4') / 60).quantize(Decimal('.00000001'), rounding=ROUND_UP), '.8f')


def safe_url(value):
    url = urlparse(value)
    if url.scheme not in ('http', 'https') or url.username or url.password or url.port or not url.hostname or not url.hostname.endswith('.aliyuncs.com'):
        raise TaskError('SUPPLIER_VIDEO_UNVERIFIED', 503)
    return url._replace(scheme='https').geturl()


def probe(buffer):
    import imageio_ffmpeg
    with tempfile.TemporaryDirectory(prefix='aiml-detext-') as directory:
        if isinstance(buffer, Path):
            file = buffer
        else:
            if not buffer or len(buffer) > LIMIT:
                raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
            file = Path(directory) / 'video.mp4'
            file.write_bytes(buffer); file.chmod(0o600)
        with file.open('rb') as stream:
            if stream.read(8)[4:8] != b'ftyp':
                raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
        result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(file)],
                                capture_output=True, timeout=20)
    text = result.stderr.decode(errors='replace')[-65536:]
    duration = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', text)
    dimensions = re.search(r'Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b', text)
    if not duration or not dimensions:
        raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
    width, height = map(int, dimensions.groups())
    if not 0 < seconds or max(width, height) > 1920 or min(width, height) > 1080:
        raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
    return seconds


class AliyunSubtitles:
    def __init__(self, access_key_id, access_key_secret, key, state_dir, client=None, probe_video=probe, wait=time.sleep, oss_bucket=None):
        self.credentials = {'access_key_id': access_key_id, 'access_key_secret': access_key_secret}
        self.client_override, self.probe, self.wait = client, probe_video, wait
        self.key = key
        self.state_dir = Path(state_dir)
        from subtitle_uploads import SubtitleUploads
        self.uploads = SubtitleUploads(self.state_dir / 'uploads', key, probe_video)
        self.direct_uploads = None
        self.results = None
        if oss_bucket:
            from oss_subtitle_uploads import DirectSubtitleUploads, OssStorage
            from subtitle_results import SubtitleResults
            storage = OssStorage(access_key_id, access_key_secret, oss_bucket)
            self.direct_uploads = DirectSubtitleUploads(self.state_dir / 'oss-uploads', key, probe_video,
                                                        storage)
            self.results = SubtitleResults(self.state_dir / 'results', key, storage)
        self.configuration = fingerprint({'credentials': self.credentials, 'price': PRICE_VERSION, 'model': MODEL})

    def client(self):
        if self.client_override: return self.client_override
        from alibabacloud_videoenhan20200320.client import Client
        from alibabacloud_tea_openapi.models import Config
        return Client(Config(**self.credentials, region_id='cn-shanghai', protocol='https', endpoint='videoenhan.cn-shanghai.aliyuncs.com'))

    def resolve_upload(self, upload_id, account):
        if self.direct_uploads and self.direct_uploads.file(upload_id).exists():
            return self.direct_uploads.resolve(upload_id, account)
        return self.uploads.resolve(upload_id, account)

    def quote(self, feature, payload, account):
        if (feature != 'subtitle-removal' or not isinstance(payload, dict)
                or set(payload) not in ({'video', 'region', 'consent'}, {'upload_id', 'region', 'consent'}) or payload['consent'] is not True):
            raise TaskError('INVALID_SUBTITLE_REQUEST', 400)
        region = payload['region']
        if 'upload_id' in payload:
            _, item = self.resolve_upload(payload['upload_id'], account)
            seconds = item['seconds']
        else:
            # Compatibility for already-installed clients; large new uploads
            # use the streamed reference path, not an enlarged JSON body.
            value = payload['video']
            if not isinstance(value, str) or len(value) > 45 * 1024 * 1024 or not value.startswith('data:video/mp4;base64,'):
                raise TaskError('INVALID_SUBTITLE_VIDEO', 400)
            try: buffer = base64.b64decode(value.split(',', 1)[1], validate=True)
            except Exception: raise TaskError('INVALID_SUBTITLE_VIDEO', 400) from None
            seconds = self.probe(buffer)
        if (not isinstance(region, dict) or set(region) != {'BX', 'BY', 'BW', 'BH'}
                or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in region.values())
                or region['BW'] <= 0 or region['BH'] <= 0 or region['BX'] + region['BW'] > 1 or region['BY'] + region['BH'] > 1):
            raise TaskError('INVALID_SUBTITLE_REGION', 400)
        return {'display_cny': tariff(seconds), 'pricing_kind': 'estimate', 'price_version': PRICE_VERSION,
                'model': MODEL, 'payload': {**payload, 'verified_seconds': seconds}, 'configuration': self.configuration,
                'billing_basis': 'supplier_usage_tariff'}

    def confirmed_usage_cost(self, spec, result, receipt, quote_id):
        state = self.checkpoint(quote_id)
        if (spec['price_version'] not in ('aliyun-viapi-detext-20261013', 'aliyun-viapi-detext-usage-20261014', PRICE_VERSION)
                or spec['model'] != MODEL or receipt.get('billed_model') != MODEL
                or not state or state.get('job_id') != receipt.get('bill_ref')):
            raise TaskError('SUPPLIER_RECEIPT_UNVERIFIED', 503)
        safe_url(result.get('VideoUrl', ''))
        # Legacy receipts stored the tariff calculated from the server-probed
        # output duration. Recover its whole-second meter only on an exact
        # tariff match; never use the input duration or a client estimate.
        charged = receipt.get('standard_tariff_cny')
        from ai_media_tasks import money
        seconds = int((money(charged) * 60 / Decimal('0.4')).to_integral_value())
        if not 1 <= seconds <= 1800 or tariff(seconds) != charged:
            raise TaskError('SUPPLIER_USAGE_UNVERIFIED', 503)
        return charged

    def checkpoint(self, quote_id, value=None):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        if not re.fullmatch(r'[a-f0-9]{40}', quote_id): raise ValueError('invalid quote')
        file = self.state_dir / (quote_id + '.bin')
        if value is None:
            if not file.is_file(): return None
            raw = file.read_bytes()
            return json.loads(AESGCM(self.key).decrypt(raw[:12], raw[12:], quote_id.encode()))
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        nonce = os.urandom(12)
        temporary = file.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(nonce + AESGCM(self.key).encrypt(nonce, json.dumps(value).encode(), quote_id.encode())); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, file)

    def execute(self, spec, account, quote_id):
        from alibabacloud_videoenhan20200320 import models
        from alibabacloud_tea_util.models import RuntimeOptions
        old = self.checkpoint(quote_id)
        if old: return self.resume(spec, quote_id)
        payload = spec['payload']
        client = self.client()
        source = None
        if 'upload_id' in payload:
            try:
                file, _ = self.resolve_upload(payload['upload_id'], account)
                if file is None:
                    url = self.direct_uploads.source_url(payload['upload_id'], account)
                else:
                    source = file.open('rb')
            except Exception:
                # This happens before any supplier operation.
                raise NoChargeFailure() from None
        else:
            source = io.BytesIO(base64.b64decode(payload['video'].split(',', 1)[1], validate=True))
        region = {k.lower(): v for k,v in payload['region'].items()}
        try:
            options = RuntimeOptions(autoretry=False, max_attempts=1, connect_timeout=15000, read_timeout=120000)
            if source is None:
                response = client.erase_video_subtitles_with_options(models.EraseVideoSubtitlesRequest(**region, video_url=url), options)
            else:
                response = client.erase_video_subtitles_advance(models.EraseVideoSubtitlesAdvanceRequest(**region, video_url_object=source), options)
        except Exception as exc:
            code = str(getattr(exc, 'code', ''))
            if re.fullmatch(r'(?:InvalidAccessKeyId\..*|SignatureDoesNotMatch|Forbidden.*|Unauthorized.*|NoPermission.*|InvalidParameter.*|InvalidFile.*)', code):
                raise NoChargeFailure() from None
            raise TaskError('SUPPLIER_OUTCOME_UNVERIFIED', 503) from None
        finally:
            if source is not None: source.close()
        job_id = response.body.request_id
        if not isinstance(job_id, str) or not re.fullmatch(r'[A-Za-z0-9-]{16,128}', job_id):
            raise TaskError('SUPPLIER_RECEIPT_UNVERIFIED', 503)
        self.checkpoint(quote_id, {'job_id': job_id})
        return self.resume(spec, quote_id)

    def recovery_ready(self, quote_id):
        from subtitle_recovery import retryable
        return retryable(self, quote_id)

    def task_progress(self, quote_id):
        from subtitle_recovery import public_progress
        return public_progress(self, quote_id)

    def recovery_failed(self, quote_id, exc):
        from subtitle_recovery import recover_failure
        recover_failure(self, quote_id, exc)

    def resume(self, spec, quote_id):
        from alibabacloud_videoenhan20200320 import models
        from alibabacloud_tea_util.models import RuntimeOptions
        state = self.checkpoint(quote_id)
        if not state: raise TaskError('SUPPLIER_OUTCOME_UNVERIFIED', 503)
        if self.results and self.results.read(quote_id):
            cached = self.results.public(quote_id)
            seconds = cached['usage']['output_seconds']
            from subtitle_recovery import progress
            progress(self, quote_id, phase='ready', last_error='', retry_at=0, source_url=None)
            return {**cached, '_subtitle_result': True}, {'standard_tariff_cny': tariff(seconds), 'supplier_debit_cny': None,
                    'bill_ref': state['job_id'], 'billed_model': MODEL}
        from subtitle_recovery import progress, retrieve
        progress(self, quote_id, phase='processing', retry_at=0)
        staged = self.state_dir / 'downloads' / (quote_id + '.source.mp4')
        if self.results and staged.exists():
            result, seconds = retrieve(self, quote_id, (self.checkpoint(quote_id) or {}).get('source_url', ''))
            return {**result, '_subtitle_result': True,
                    'usage': {'output_seconds': seconds, 'billable_seconds': math.ceil(seconds)}}, {
                'standard_tariff_cny': tariff(seconds), 'supplier_debit_cny': None,
                'bill_ref': state['job_id'], 'billed_model': MODEL}
        for _ in range(360):
            data = self.client().get_async_job_result_with_options(models.GetAsyncJobResultRequest(job_id=state['job_id']),
                    RuntimeOptions(autoretry=False, max_attempts=1, connect_timeout=15000, read_timeout=15000)).body.data
            if data.status in ('PROCESS_FAILED', 'TIMEOUT_FAILED', 'LIMIT_RETRY_FAILED'):
                message = str(getattr(data, 'error_message', '') or '')
                for credential in self.credentials.values():
                    if credential: message = message.replace(credential, '[redacted]')
                message = re.sub(r'https?://\S+|ark-[A-Za-z0-9-]+', '[redacted]', message)[:500]
                code = str(getattr(data, 'error_code', '') or '')
                evidence = {'status': data.status, 'bill_ref': state['job_id'], 'error_code': code if re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', code) else 'UNKNOWN',
                            'error_message': message}
                self.checkpoint(quote_id, {**state, 'failure_evidence': evidence})
                raise SupplierTaskFailure(evidence)
            if data.status == 'PROCESS_SUCCESS':
                result = json.loads(data.result) if isinstance(data.result, str) else data.result
                url = safe_url(result.get('VideoUrl') or result.get('videoUrl'))
                if self.results:
                    result, seconds = retrieve(self, quote_id, url)
                    return {**result, '_subtitle_result': True,
                            'usage': {'output_seconds': seconds, 'billable_seconds': math.ceil(seconds)}}, {
                        'standard_tariff_cny': tariff(seconds), 'supplier_debit_cny': None,
                        'bill_ref': state['job_id'], 'billed_model': MODEL}
                # Verify actual output duration. Do not bill a client-supplied duration.
                with tempfile.TemporaryDirectory(prefix='aiml-detext-output-') as directory:
                    file = Path(directory) / 'output.mp4'
                    with build_opener(NoRedirect()).open(Request(url), timeout=60) as response, file.open('wb') as output:
                        file.chmod(0o600)
                        received = 0
                        while chunk := response.read(1024 ** 2):
                            received += len(chunk)
                            if received > 2 * LIMIT:
                                raise TaskError('SUPPLIER_VIDEO_UNVERIFIED', 503)
                            output.write(chunk)
                    seconds = self.probe(file)
                    if self.results:
                        self.results.preserve(quote_id, file, seconds)
                        result = {**self.results.public(quote_id), '_subtitle_result': True,
                                  'usage': {'output_seconds': seconds, 'billable_seconds': math.ceil(seconds)}}
                    else:
                        result = {'VideoUrl': url, 'usage': {'output_seconds': seconds, 'billable_seconds': math.ceil(seconds)}}
                return result, {'standard_tariff_cny': tariff(seconds), 'supplier_debit_cny': None,
                        'bill_ref': state['job_id'], 'billed_model': MODEL}
            self.wait(5)
        raise TaskError('SUPPLIER_TASK_PENDING', 503)

    def public_result(self, result, quote_id):
        if not self.results or (not result.get('_subtitle_result') and not self.results.read(quote_id)):
            return result
        try:
            fresh = self.results.public(quote_id)
            return {**fresh, 'usage': result['usage']}
        except TaskError as exc:
            # The settled charge remains visible even if retained media expired.
            return {'usage': result['usage'], 'download_error': exc.code}


class AliyunReconciler:
    """Only an exact RequestId/instance bill can settle; aggregate bills wait.

    A missing row, deferred bill, unpaid bill or unrelated account usage is not
    evidence of a zero charge. No estimate is converted into actual deduction.
    """
    def __init__(self, adapter):
        self.adapter = adapter; self.attempts = {}; self.lock = threading.Lock()

    def __call__(self, tasks, quote_id):
        with self.lock:
            if time.time() - self.attempts.get(quote_id, 0) < 60: return
            self.attempts[quote_id] = time.time()
            with tasks.transaction() as conn:
                row = conn.execute('SELECT * FROM aiml_generation_tasks WHERE quote_id=?', (quote_id,)).fetchone()
            if not row or row['status'] not in ('awaiting-bill', 'failed-awaiting-bill'): return
            spec, receipt = tasks.unseal(row['spec']), tasks.unseal(row['receipt'])
            if spec['provider'] != 'aliyun' or spec['configuration'] != self.adapter.configuration: return
            from alibabacloud_bssopenapi20171214.client import Client
            from alibabacloud_bssopenapi20171214 import models
            from alibabacloud_tea_openapi.models import Config
            from alibabacloud_tea_util.models import RuntimeOptions
            moment = dt.datetime.fromtimestamp(receipt['execution_started'], dt.timezone(dt.timedelta(hours=8)))
            client = Client(Config(**self.adapter.credentials, endpoint='business.aliyuncs.com', protocol='https'))
            response = client.describe_instance_bill_with_options(models.DescribeInstanceBillRequest(
                billing_cycle=moment.strftime('%Y-%m'), billing_date=moment.strftime('%Y-%m-%d'), granularity='DAILY',
                instance_id=receipt['bill_ref'], is_billing_item=True, is_hide_zero_charge=False, max_results=100),
                RuntimeOptions(autoretry=False, max_attempts=1, read_timeout=15000)).body.to_map()
            data = response.get('Data', {})
            items = data.get('Items', [])
            if (response.get('Success') is not True or data.get('NextToken') or len(items) != 1): return
            bill = items[0]
            if (bill.get('InstanceID') != receipt['bill_ref'] or bill.get('BillingDate') != moment.strftime('%Y-%m-%d')
                    or bill.get('Currency') != 'CNY' or bill.get('SubscriptionType') != 'PayAsYouGo'
                    or str(bill.get('OutstandingAmount', 'unknown')) not in ('0', '0.0')): return
            # Only fields from the authenticated billing response are accepted.
            from ai_media_tasks import money
            debit = money(str(bill.get('PaymentAmount')))
            billed = money(str(bill.get('PretaxGrossAmount')))
            tasks.confirm_supplier_bill(quote_id, 'aliyun', receipt['bill_ref'], format(debit, '.8f'), format(billed, '.8f'),
                billing_evidence={'source': 'DescribeInstanceBill', 'day': moment.strftime('%Y-%m-%d'),
                                  'bill_sha256': fingerprint(bill)})
