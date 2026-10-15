import base64
import tempfile
import unittest
from pathlib import Path
from aliyun_platform import AliyunSubtitles, tariff, safe_url
from ai_media_tasks import TaskError
from ai_media_tasks import SupplierTaskFailure
from types import SimpleNamespace
from unittest.mock import patch

class AliyunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.adapter = AliyunSubtitles('synthetic-id', 'synthetic-secret', b'k' * 32, self.tmp.name, probe_video=lambda data: 5)
        self.payload = {'video': 'data:video/mp4;base64,' + base64.b64encode(b'test-video').decode(),
                        'region': {'BX':0,'BY':.75,'BW':1,'BH':.25}, 'consent': True}

    def test_server_quote_ignores_client_cost_and_uses_verified_duration(self):
        quote = self.adapter.quote('subtitle-removal', self.payload, 'account')
        self.assertEqual(quote['display_cny'], '0.03333334')
        self.assertEqual(quote['payload']['verified_seconds'], 5)
        for key in ('duration', 'cost_cny', 'apiKey', 'url'):
            with self.assertRaises(TaskError): self.adapter.quote('subtitle-removal', {**self.payload,key:1},'account')

    def test_region_consent_and_external_urls_are_rejected(self):
        for extra in ({'consent':False}, {'region':{'BX':0,'BY':.9,'BW':1,'BH':.2}}, {'video':'https://example.com/video'}):
            with self.assertRaises(TaskError): self.adapter.quote('subtitle-removal', {**self.payload,**extra}, 'account')
        for url in ('http://127.0.0.1/file', 'https://aliyuncs.com.evil.example/file', 'https://secret@bucket.aliyuncs.com/file'):
            with self.assertRaises(TaskError): safe_url(url)
        self.assertEqual(safe_url('http://bucket.aliyuncs.com/file'), 'https://bucket.aliyuncs.com/file')

    def test_accepted_job_checkpoint_is_encrypted_and_authenticates_quote(self):
        qid = 'a' * 40
        self.adapter.checkpoint(qid, {'job_id':'synthetic-accepted-job'})
        self.assertNotIn(b'synthetic-accepted-job', (Path(self.tmp.name)/(qid+'.bin')).read_bytes())
        self.assertEqual(self.adapter.checkpoint(qid)['job_id'], 'synthetic-accepted-job')
        self.assertEqual(tariff(.1), '0.00666667')

    def test_existing_output_receipt_meter_requires_exact_tariff_and_job_identity(self):
        qid='a'*40; self.adapter.checkpoint(qid, {'job_id':'synthetic-job'})
        spec={'price_version':'aliyun-viapi-detext-20261013','model':'EraseVideoSubtitles'}
        receipt={'billed_model':'EraseVideoSubtitles','bill_ref':'synthetic-job','standard_tariff_cny':'0.03333334'}
        result={'VideoUrl':'https://bucket.aliyuncs.com/synthetic.mp4'}
        self.assertEqual(self.adapter.confirmed_usage_cost(spec,result,receipt,qid),'0.03333334')
        for change in ({'bill_ref':'wrong-job'},{'standard_tariff_cny':'0.03'}):
            with self.assertRaises(TaskError): self.adapter.confirmed_usage_cost(spec,result,{**receipt,**change},qid)

    def test_all_terminal_failures_stop_polling_and_keep_only_private_redacted_evidence(self):
        modules = {'alibabacloud_videoenhan20200320': SimpleNamespace(models=SimpleNamespace(GetAsyncJobResultRequest=SimpleNamespace)),
                   'alibabacloud_tea_util.models': SimpleNamespace(RuntimeOptions=SimpleNamespace)}
        for status in ('PROCESS_FAILED', 'TIMEOUT_FAILED', 'LIMIT_RETRY_FAILED'):
            qid = 'a' * 40; self.adapter.checkpoint(qid, {'job_id': 'synthetic-job'})
            data = SimpleNamespace(status=status, error_code='InternalError', error_message='synthetic-secret https://private.aliyuncs.com/?Signature=secret')
            self.adapter.client_override = SimpleNamespace(get_async_job_result_with_options=lambda *args: SimpleNamespace(body=SimpleNamespace(data=data)))
            self.adapter.wait = lambda _: self.fail('terminal failure must not wait')
            with patch.dict('sys.modules', modules), self.assertRaises(SupplierTaskFailure) as caught:
                self.adapter.resume({}, qid)
            self.assertEqual(caught.exception.evidence['status'], status)
            self.assertNotIn('synthetic-secret', str(caught.exception.evidence))
            self.assertNotIn('Signature', str(caught.exception.evidence))

if __name__ == '__main__': unittest.main()
