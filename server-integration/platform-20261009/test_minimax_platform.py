import base64
import json
import unittest
from minimax_platform import MiniMaxPreview, characters, cost
from ai_media_tasks import NoChargeFailure, TaskError


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.adapter = MiniMaxPreview('synthetic-secret-not-production', self.request)
        self.payload = {'audio': 'data:audio/wav;base64,' + base64.b64encode(b'synthetic-audio').decode(),
                        'previewText': '你好ABC', 'model': 'speech-2.8-turbo', 'consent': True}

    def request(self, path, raw, content_type):
        self.calls.append((path, raw))
        if path == '/files/upload':
            return 200, {'base_resp': {'status_code': 0}, 'file': {'file_id': 1234567890123456789}}
        return 200, {'base_resp': {'status_code': 0}, 'demo_audio': 'https://audio.t2a.minimaxi.com/synthetic.mp3',
                     'extra_info': {'usage_characters': 7, 'audio_length': 1000}}

    def test_quote_uses_this_text_and_model_without_default_ceiling(self):
        quote = self.adapter.quote('voice', self.payload, 'owner')
        self.assertEqual(quote['display_cny'], '0.00140000')
        self.assertEqual(self.calls, [])
        self.assertNotIn('budget', quote)
        self.assertNotIn('synthetic-secret', json.dumps(quote))

    def test_chinese_counted_twice_and_punctuation_once(self):
        self.assertEqual(characters('你好A，'), 6)
        self.assertEqual(cost(6, 'speech-2.8-hd'), '0.00210000')

    def test_preview_cost_does_not_add_formal_tts_activation_fee(self):
        quote = self.adapter.quote('voice', self.payload, 'owner')
        _, receipt = self.adapter.execute(quote, 'owner', 'a'*40)
        self.assertEqual(receipt['standard_tariff_cny'], '0.00140000')
        self.assertEqual([c[0] for c in self.calls], ['/files/upload', '/voice_clone'])

    def test_free_character_fields_do_not_replace_verified_supplier_bill(self):
        def request(path, *args):
            status, data = self.request(path, *args)
            if path == '/voice_clone':
                data['billing'] = {'charged_cny': '0', 'free_characters_used': 7}
            return status, data
        self.adapter.request = request
        _, receipt = self.adapter.execute(self.adapter.quote('voice', self.payload, 'owner'), 'owner', 'a'*40)
        self.assertEqual(receipt['standard_tariff_cny'], '0.00140000')
        self.assertIsNone(receipt['supplier_debit_cny'])

    def test_int64_file_id_is_kept_exact(self):
        quote = self.adapter.quote('voice', self.payload, 'owner')
        self.adapter.execute(quote, 'owner', 'a'*40)
        self.assertEqual(json.loads(self.calls[-1][1])['file_id'], 1234567890123456789)

    def test_failed_upload_proves_no_paid_clone_was_submitted(self):
        self.adapter.request = lambda *args: (403, {'base_resp': {'status_code': 1004}})
        with self.assertRaises(NoChargeFailure):
            self.adapter.execute(self.adapter.quote('voice', self.payload, 'owner'), 'owner', 'a'*40)

    def test_clone_timeout_is_unknown_and_not_declared_free(self):
        def request(path, *args):
            if path == '/voice_clone':
                raise TimeoutError()
            return self.request(path, *args)
        self.adapter.request = request
        with self.assertRaises(TaskError) as caught:
            self.adapter.execute(self.adapter.quote('voice', self.payload, 'owner'), 'owner', 'a'*40)
        self.assertEqual(caught.exception.code, 'SUPPLIER_TIMEOUT')

    def test_missing_authoritative_usage_cannot_be_charged(self):
        def request(path, *args):
            status, data = self.request(path, *args)
            if path == '/voice_clone':
                data['extra_info'] = {}
            return status, data
        self.adapter.request = request
        with self.assertRaises(TaskError):
            self.adapter.execute(self.adapter.quote('voice', self.payload, 'owner'), 'owner', 'a'*40)

    def test_untrusted_audio_download_hosts_are_rejected(self):
        def request(path, *args):
            status, data = self.request(path, *args)
            if path == '/voice_clone':
                data['demo_audio'] = 'https://attacker.invalid/sample.mp3'
            return status, data
        self.adapter.request = request
        with self.assertRaises(TaskError):
            self.adapter.execute(self.adapter.quote('voice', self.payload, 'owner'), 'owner', 'a'*40)

    def test_official_oss_audio_host_is_allowed(self):
        def request(path, *args):
            status, data = self.request(path, *args)
            if path == '/voice_clone':
                data['demo_audio'] = 'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/synthetic.mp3'
            return status, data
        self.adapter.request = request
        self.adapter.execute(self.adapter.quote('voice', self.payload, 'owner'), 'owner', 'a'*40)

    def test_response_survives_parsing_failure_without_repeating_paid_call(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            key = b'x'*32
            def request(path, *args):
                status, data = self.request(path, *args)
                if path == '/voice_clone': data['extra_info'] = {}
                return status, data
            adapter = MiniMaxPreview('synthetic', request, key, folder)
            spec = adapter.quote('voice', self.payload, 'owner')
            with self.assertRaises(TaskError): adapter.execute(spec, 'owner', 'b'*40)
            self.assertTrue(adapter.resumable('b'*40))
            encrypted = (Path(folder)/('b'*40+'.bin')).read_bytes()
            self.assertNotIn(b'demo_audio', encrypted)
            with self.assertRaises(TaskError): adapter.execute(spec, 'owner', 'b'*40)
            self.assertEqual(len(self.calls), 2)

    def test_explicit_clone_permission_rejection_is_no_charge(self):
        def request(path, *args):
            if path == '/voice_clone': return 200, {'base_resp': {'status_code':2038}}
            return self.request(path, *args)
        self.adapter.request = request
        with self.assertRaises(NoChargeFailure):
            self.adapter.execute(self.adapter.quote('voice', self.payload, 'owner'), 'owner', 'a'*40)

    def test_timeout_checkpoint_keeps_safe_cause_and_restart_never_repeats_paid_call(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            def request(path,*args):
                if path == '/voice_clone':
                    self.calls.append((path,b'')); raise TimeoutError('private signed URL must not be logged')
                return self.request(path,*args)
            adapter=MiniMaxPreview('synthetic',request,b'x'*32,folder)
            spec=adapter.quote('voice',self.payload,'owner')
            with self.assertRaises(TaskError):adapter.execute(spec,'owner','c'*40)
            checkpoint=adapter.checkpoint('c'*40)
            self.assertEqual(checkpoint['phase'],'response_missing')
            self.assertEqual(checkpoint['error_code'],'SUPPLIER_TIMEOUT')
            self.assertNotIn('private',json.dumps(checkpoint))
            restarted=MiniMaxPreview('synthetic',request,b'x'*32,folder)
            with self.assertRaises(TaskError):restarted.execute(spec,'owner','c'*40)
            self.assertEqual(len(self.calls),2)

    def test_client_budget_credentials_and_formal_synthesis_are_rejected(self):
        for extra in ({'budget_cny': '100'}, {'apiKey': 'personal'}, {'voice_id': 'existing'}, {'model': 'unknown'}):
            with self.assertRaises(TaskError):
                self.adapter.quote('voice', {**self.payload, **extra}, 'owner')


if __name__ == '__main__':
    unittest.main()

class UsageSettlementTests(unittest.TestCase):
    def test_actual_characters_settle_once_with_explicit_usage_policy(self):
        from test_ai_media_tasks import TaskTests
        fixture = TaskTests(); fixture.setUp()
        self.addCleanup(fixture.tearDown)
        preview = PreviewTests(); preview.setUp()
        fixture.tasks.adapters['minimax'] = preview.adapter
        quoted = fixture.tasks.handle('quote', {'app_name':'ai-media-library','request_id':'voice-usage-policy',
            'feature':'voice','provider':'minimax','api_source':'platform_api','payload':preview.payload}, fixture.headers)
        self.assertEqual(quoted['billing_basis'], 'supplier_usage_tariff')
        run = {'app_name':'ai-media-library','quote_id':quoted['quote_id'],'confirm_run':True}
        result = fixture.tasks.handle('run', run, fixture.headers)
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['points_used'], '0.280000')
        self.assertEqual(result['settlement_basis'], 'supplier_usage_tariff')
        fixture.tasks.handle('run', run, fixture.headers)
        self.assertEqual(len(preview.calls), 2)
