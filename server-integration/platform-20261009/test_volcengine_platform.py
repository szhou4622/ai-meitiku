import base64
import unittest
from decimal import Decimal
from volcengine_platform import SeedLite, MODEL, token_cost
from ai_media_tasks import TaskError, NoChargeFailure


class SeedTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.response = {'id': 'synthetic-provider-request', 'model': MODEL,
                         'choices': [{'message': {'content': 'synthetic result'}, 'finish_reason': 'stop'}],
                         'usage': {'prompt_tokens': 100, 'completion_tokens': 10, 'total_tokens': 110,
                                   'prompt_tokens_details': {'cached_tokens': 20}}}
        self.adapter = SeedLite('synthetic-secret-not-production', 'ep-synthetic', self.request)

    def request(self, body):
        self.calls.append(body)
        return 200, self.response

    def quote(self, **extra):
        return self.adapter.quote('prompt-library', {'messages': [{'role': 'user', 'content': '你好'}],
                                                    'max_tokens': 100, **extra}, 'owner')

    def test_estimate_is_derived_from_this_input_and_output_not_a_fixed_points_limit(self):
        first = self.quote()
        second = self.quote(max_tokens=200)
        self.assertGreater(Decimal(second['display_cny']), Decimal(first['display_cny']))
        self.assertEqual(self.calls, [])
        self.assertNotIn('budget', first)
        self.assertEqual(first['payload']['thinking'], {'type': 'disabled'})

    def test_usage_and_cache_price_preserve_small_fractional_costs(self):
        self.assertEqual(token_cost(100, 10, 20), '0.00009420')
        self.assertEqual(token_cost(1, 0, 0), '0.00000080')
        self.assertEqual(token_cost(1, 0, 1), '0.00000016')

    def test_free_allowance_fields_do_not_replace_verified_supplier_bill(self):
        self.response['billing'] = {'charged_cny': '0', 'free_quota_used': True}
        self.response['usage']['free_tokens'] = 110
        _, receipt = self.adapter.execute(self.quote(), 'owner', 'a'*40)
        self.assertEqual(receipt['standard_tariff_cny'], '0.00009420')
        self.assertIsNone(receipt['supplier_debit_cny'])

    def test_execution_uses_private_endpoint_and_receipt_uses_confirmed_model(self):
        result, receipt = self.adapter.execute(self.quote(), 'owner', 'a'*40)
        self.assertEqual(self.calls[0]['model'], 'ep-synthetic')
        self.assertEqual(receipt['billed_model'], MODEL)
        self.assertEqual(receipt['standard_tariff_cny'], '0.00009420')
        self.assertEqual(result['choices'][0]['message']['content'], 'synthetic result')

    def test_images_are_default_high_detail_and_quotes_include_image_tokens(self):
        data = 'data:image/jpeg;base64,' + base64.b64encode(b'synthetic-image').decode()
        q = self.quote(messages=[{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': data}}]}])
        self.assertEqual(q['payload']['messages'][0]['content'][0]['image_url']['detail'], 'high')
        self.assertGreater(Decimal(q['display_cny']), Decimal(self.quote()['display_cny']))

    def test_remote_urls_tools_customer_keys_and_user_budgets_are_rejected(self):
        for extra in ({'budget_cny': '1'}, {'apiKey': 'personal'}, {'model': 'some-other-model'},
                      {'tools': []}, {'messages': [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'https://attacker.invalid/x.jpg'}}]}]}):
            with self.assertRaises(TaskError):
                self.quote(**extra)

    def test_first_text_release_rejects_images_before_supplier_execution(self):
        self.adapter.allow_images = False
        data = 'data:image/jpeg;base64,' + base64.b64encode(b'synthetic-image').decode()
        with self.assertRaises(TaskError) as error:
            self.quote(messages=[{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': data}}]}])
        self.assertEqual(error.exception.code, 'PLATFORM_TEXT_ONLY')
        self.assertEqual(self.calls, [])

    def test_missing_usage_and_wrong_models_never_settle(self):
        for key, value in (('usage', {}), ('model', 'doubao-seed-2-0-pro-260215')):
            saved = self.response[key]
            self.response[key] = value
            with self.assertRaises(TaskError):
                self.adapter.execute(self.quote(), 'owner', 'a'*40)
            self.response[key] = saved

    def test_invalid_cache_and_total_counts_never_settle(self):
        for prompt, output, cache in ((1, 1, 2), (True, 1, 0), (1, -1, 0)):
            with self.assertRaises(TaskError):
                token_cost(prompt, output, cache)
        self.response['usage']['total_tokens'] = 999
        with self.assertRaises(TaskError):
            self.adapter.execute(self.quote(), 'owner', 'a'*40)

    def test_explicit_auth_rejection_releases_but_ambiguous_failure_keeps_reservation(self):
        for status in (401, 403):
            self.adapter.request = lambda body: (status, {'error': {'code': 'AuthenticationError'}})
            with self.assertRaises(NoChargeFailure):
                self.adapter.execute(self.quote(), 'owner', 'a'*40)
        self.adapter.request = lambda body: (500, {'error': {'code': 'InternalError'}})
        with self.assertRaises(TaskError):
            self.adapter.execute(self.quote(), 'owner', 'a'*40)

    def test_unsupported_audio_billing_is_rejected_before_submission(self):
        with self.assertRaises(TaskError):
            self.quote(messages=[{'role': 'user', 'content': [{'type': 'input_audio', 'input_audio': {'data': 'synthetic'}}]}])
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
