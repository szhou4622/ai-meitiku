import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import test_ai_media_tasks as fixture
from ai_media_platform import build_handler, PREFIX


class TaskGatewayTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.TaskTests()
        self.fixture.setUp()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), build_handler(
            self.fixture.ledger.auth, {'volcengine': {}}, lambda: True, self.fixture.tasks))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.fixture.tearDown()

    def call(self, action, data, auth=True):
        client = HTTPConnection(*self.server.server_address, timeout=3)
        client.request('POST', PREFIX + 'tasks/' + action, json.dumps(data),
                       {'Content-Type': 'application/json', **(self.fixture.headers if auth else {})})
        response = client.getresponse()
        body = json.loads(response.read())
        client.close()
        return response.status, body

    def quote(self, auth=True):
        return self.call('quote', {'app_name': 'ai-media-library', 'request_id': 'http-task',
            'feature': 'schemes', 'provider': 'volcengine', 'api_source': 'platform_api',
            'payload': {'text': 'synthetic-private-http-text'}}, auth)

    def test_http_quote_then_cancel_does_not_reserve_or_call_supplier(self):
        status, quote = self.quote()
        self.assertEqual(status, 200)
        self.assertEqual(quote['points'], '4.000000')
        self.assertEqual(self.fixture.balance()['reserved_units'], 0)
        self.assertEqual(self.fixture.adapter.calls, 0)
        self.assertEqual(self.call('run', {'app_name': 'ai-media-library', 'quote_id': quote['quote_id'], 'confirm_run': False})[0], 400)
        self.assertEqual(self.fixture.balance()['reserved_units'], 0)

    def test_http_confirm_and_replay_return_one_actual_charge(self):
        _, quote = self.quote()
        data = {'app_name': 'ai-media-library', 'quote_id': quote['quote_id'], 'confirm_run': True}
        status, result = self.call('run', data)
        self.assertEqual(status, 200)
        self.assertEqual(result['points_used'], '2.469134')
        self.assertEqual(self.call('run', data)[1], result)
        self.assertEqual(self.fixture.adapter.calls, 1)

    def test_http_auth_and_endpoint_allowlist(self):
        self.assertEqual(self.quote(auth=False)[0], 401)
        self.assertEqual(self.call('internal/commit', {'app_name': 'ai-media-library'})[0], 404)
        self.assertEqual(self.call('confirm-bill', {'app_name': 'ai-media-library', 'supplier_debit_cny': '0'})[0], 404)
        self.assertEqual(self.fixture.adapter.calls, 0)

    def test_capabilities_advertise_only_the_deployed_feature_scope(self):
        self.fixture.tasks.allowed_features = frozenset({'prompt-library'})
        client = HTTPConnection(*self.server.server_address, timeout=3)
        client.request('POST', PREFIX + 'capabilities', json.dumps({'app_name': 'ai-media-library'}),
                       {'Content-Type': 'application/json', **self.fixture.headers})
        response = client.getresponse()
        body = json.loads(response.read())
        client.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(body['enabled_features'], ['prompt-library'])
        self.assertTrue(body['generation_enabled'])
        self.assertNotIn('apiKey', json.dumps(body))

    def test_upload_authentication_precedes_reading_large_body(self):
        from aliyun_platform import AliyunSubtitles
        adapter = AliyunSubtitles('fake','fake',self.fixture.key,self.fixture.ledger.temp.name,probe_video=lambda p:5)
        self.fixture.tasks.adapters['aliyun'] = adapter
        client = HTTPConnection(*self.server.server_address, timeout=3)
        client.request('POST', PREFIX+'uploads/subtitle', b'', {'Content-Type':'video/mp4','Content-Length':str(1024**3)})
        response = client.getresponse(); self.assertEqual(response.status,401);response.read();client.close()
        self.assertEqual(list(adapter.uploads.root.iterdir()), [])

    def test_upload_is_free_and_returns_no_storage_path_or_credentials(self):
        from aliyun_platform import AliyunSubtitles
        self.fixture.tasks.adapters['aliyun'] = AliyunSubtitles('fake','fake',self.fixture.key,self.fixture.ledger.temp.name,probe_video=lambda p:5)
        client = HTTPConnection(*self.server.server_address, timeout=3)
        client.request('POST', PREFIX+'uploads/subtitle', b'fake-video', {'Content-Type':'video/mp4',**self.fixture.headers})
        response = client.getresponse();data=json.loads(response.read());client.close()
        self.assertEqual(response.status,200);self.assertEqual(data['verified_seconds'],5)
        self.assertNotIn('path',data);self.assertNotIn('fake',json.dumps(data))
        self.assertEqual(self.fixture.balance()['reserved_units'],0);self.assertEqual(self.fixture.adapter.calls,0)
        self.assertEqual(self.call('waive-legacy-unknown',{'app_name':'ai-media-library'})[0],404)


if __name__ == '__main__':
    unittest.main()
