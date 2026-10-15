import unittest
from unittest.mock import patch
import test_ai_media_tasks as fixtures
from platform_settlement import LoopbackSettlement
from ai_media_tasks import TaskError


class PromptTextEntryTests(unittest.TestCase):
    def test_first_release_rejects_other_features_before_supplier_or_reservation(self):
        fixture = fixtures.TaskTests()
        fixture.setUp()
        try:
            fixture.tasks.allowed_features = frozenset({'prompt-library'})
            with self.assertRaises(TaskError) as error:
                fixture.tasks.quote({'app_name': 'ai-media-library', 'request_id': 'other-feature',
                    'feature': 'classifier', 'provider': 'volcengine', 'api_source': 'platform_api', 'payload': {}}, 'account')
            self.assertEqual(error.exception.code, 'PLATFORM_FEATURE_UNAVAILABLE')
        finally:
            fixture.tearDown()

    def test_settlement_bridge_uses_private_route_and_never_forwards_arbitrary_headers(self):
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'{"ok":true,"app_name":"ai-media-library","status":"committed"}'
        with patch('platform_settlement.urlopen', return_value=Response()) as call:
            bridge = LoopbackSettlement('synthetic-private-token-' + 'x' * 32)
            bridge('commit', {'app_name': 'ai-media-library'}, {'Authorization': 'Bearer synthetic', 'X-Device-Credential': 'synthetic-proof', 'X-AIML-Settlement-Token': 'untrusted', 'Cookie': 'untrusted'})
            request = call.call_args.args[0]
            self.assertEqual(request.full_url, 'http://127.0.0.1:8842/api/license/ai-media-library/points/internal/commit')
            self.assertEqual(request.get_header('X-aiml-settlement-token'), 'synthetic-private-token-' + 'x' * 32)
            self.assertIsNone(request.get_header('Cookie'))


if __name__ == '__main__':
    unittest.main()
