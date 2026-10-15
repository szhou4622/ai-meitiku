import json
import os
import sqlite3
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'points-20261009'))
from test_ai_media_points import SettlementTests
from ai_media_tasks import MediaTasks, TaskError, NoChargeFailure, APP, billing_amount


class Adapter:
    configuration = 'synthetic-price-and-model-version'
    calls = 0
    barrier = None
    error = None
    debit = '0.01234567'
    billed = None

    def quote(self, feature, payload, account):
        if set(payload) != {'text'}:
            raise TaskError('INVALID_SUPPLIER_INPUT', 400)
        return {'display_cny': '0.02', 'pricing_kind': 'estimate',
                'price_version': 'synthetic-v1', 'model': 'synthetic-model',
                'payload': payload, 'configuration': self.configuration}

    def execute(self, spec, account, quote):
        self.calls += 1
        if self.barrier:
            self.barrier.wait(5)
        if self.error:
            raise self.error
        receipt = {
            'standard_tariff_cny': '0.01234567', 'supplier_debit_cny': self.debit, 'bill_ref': 'provider:' + quote, 'billed_model': 'synthetic-model'}
        if self.billed is not None:
            receipt['billed_amount_cny'] = self.billed
        return {'choices': [{'message': {'content': 'synthetic result'}}]}, receipt


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.ledger = SettlementTests()
        self.ledger.setUp()
        self.ledger.funded()
        self.adapter = Adapter()
        self.path = Path(self.ledger.temp.name) / 'tasks.sqlite3'
        self.key = os.urandom(32)
        self.enabled = True
        self.clock = 1000
        self.fail_commit = False
        self.tasks = self.create()
        self.tasks.initialize()
        self.headers = self.ledger.auth_headers

    def tearDown(self):
        self.ledger.tearDown()

    def settle(self, action, data, headers):
        if action == 'commit' and self.fail_commit:
            raise RuntimeError('synthetic settlement transport failure')
        return self.ledger.engine.handle(action, data, {**headers, 'X-AIML-Settlement-Token': self.ledger.engine.internal_token})

    def create(self):
        return MediaTasks(self.path, self.key, self.ledger.auth, self.settle,
                          {'volcengine': self.adapter}, lambda: self.enabled, lambda: self.clock)

    def quote(self, request='one', **overrides):
        return self.tasks.handle('quote', {'app_name': APP, 'request_id': request, 'feature': 'schemes',
            'provider': 'volcengine', 'api_source': 'platform_api', 'payload': {'text': 'synthetic-private-text'}, **overrides}, self.headers)

    def execute_task(self, quote, **extra):
        return self.tasks.handle('run', {'app_name': APP, 'quote_id': quote['quote_id'], 'confirm_run': True, **extra}, self.headers)

    def assert_code(self, code, fn):
        with self.assertRaises(TaskError) as caught:
            fn()
        self.assertEqual(caught.exception.code, code)

    def balance(self):
        return self.ledger.call('balance')

    def test_quote_is_read_only_and_contains_no_budget_input(self):
        quote = self.quote()
        self.assertEqual(quote['points'], '4.000000')
        self.assertEqual(self.balance()['reserved_units'], 0)
        self.assertEqual(self.balance()['balance'], '1000.000000')
        self.assertEqual(self.adapter.calls, 0)
        self.assertNotIn('reserve_cny', quote)

    def test_confirmation_required_and_caller_cost_rejected(self):
        quote = self.quote()
        self.assert_code('RUN_CONFIRMATION_REQUIRED', lambda: self.execute_task(quote, confirm_run=False))
        self.assert_code('RUN_CONFIRMATION_REQUIRED', lambda: self.execute_task(quote, cost_cny='0'))
        self.assert_code('INVALID_QUOTE_REQUEST', lambda: self.quote(budget_cny='1'))
        self.assert_code('INVALID_QUOTE_REQUEST', lambda: self.quote(max_points=500))
        self.assertEqual(self.adapter.calls, 0)
        self.assertEqual(self.balance()['reserved_units'], 0)

    def test_actual_receipt_settles_precise_points_and_releases_unused(self):
        result = self.execute_task(self.quote())
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['points_used'], '2.469134')
        self.assertEqual(self.balance()['balance'], '997.530866')
        self.assertEqual(self.balance()['reserved_units'], 0)

    def test_standard_charge_and_supplier_deduction_are_separate_private_records(self):
        quote = self.quote()
        result = self.execute_task(quote)
        self.assertEqual(result['billing_basis'], 'supplier_debit_with_zero_fallback')
        with sqlite3.connect(self.path) as conn:
            receipt = self.tasks.unseal(conn.execute('SELECT receipt FROM aiml_generation_tasks WHERE quote_id=?', (quote['quote_id'],)).fetchone()[0])
        self.assertEqual(receipt['standard_tariff_cny'], '0.01234567')
        self.assertEqual(receipt['supplier_debit_cny'], '0.01234567')
        self.assertNotIn('supplier_debit_cny', result)

    def test_positive_supplier_debit_wins_over_standard_cost(self):
        self.adapter.debit = '0.01'
        result = self.execute_task(self.quote())
        self.assertEqual(result['points_used'], '2.000000')
        self.assertEqual(result['settlement_basis'], 'supplier_debit')

    def test_zero_debit_uses_standard_usage_cost(self):
        self.adapter.debit = '0'
        result = self.execute_task(self.quote())
        self.assertEqual(result['points_used'], '2.469134')
        self.assertEqual(result['settlement_basis'], 'standard_tariff_zero_debit')

    def test_zero_debit_prefers_verified_pre_allowance_amount(self):
        self.adapter.debit, self.adapter.billed = '0', '0.01'
        quote = self.quote()
        result = self.execute_task(quote)
        self.assertEqual(result['points_used'], '2.000000')
        self.assertEqual(result['settlement_basis'], 'billed_amount_zero_debit')
        replay = self.tasks.confirm_supplier_bill(quote['quote_id'], 'volcengine', 'provider:' + quote['quote_id'], '0.00000000', '0.01000000')
        self.assertEqual(replay, result)

    def pending_bill(self):
        self.adapter.debit = None
        quote = self.quote()
        result = self.execute_task(quote)
        self.assertEqual(result['status'], 'awaiting-bill')
        self.assertTrue(result['billing_pending'])
        self.assertIn('result', result)
        self.assertNotIn('points_used', result)
        self.assertEqual(self.balance()['balance'], '1000.000000')
        self.assertEqual(self.balance()['reserved'], '4.000000')
        return quote

    def reconcile(self, quote, debit, billed=None, **overrides):
        args = dict(quote_id=quote['quote_id'], provider='volcengine', bill_ref='provider:' + quote['quote_id'],
                    supplier_debit_cny=debit, billed_amount_cny=billed)
        return self.tasks.confirm_supplier_bill(**{**args, **overrides})

    def test_unknown_bill_retains_result_and_reservation_across_restart(self):
        quote = self.pending_bill()
        self.tasks = self.create()
        self.tasks.initialize()
        self.assertEqual(self.execute_task(quote)['status'], 'awaiting-bill')
        self.assertEqual(self.quote()['status'], 'awaiting-bill')
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual(self.balance()['balance'], '1000.000000')

    def test_verified_positive_bill_settles_once_without_regeneration(self):
        quote = self.pending_bill()
        self.assertEqual(self.reconcile(quote, '0.01')['status'], 'settling')
        result = self.execute_task(quote)
        self.assertEqual(result['points_used'], '2.000000')
        self.assertEqual(self.reconcile(quote, '0.01000000'), result)
        self.assertEqual(self.execute_task(quote), result)
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual(self.balance()['balance'], '998.000000')
        self.assertEqual(self.balance()['reserved_units'], 0)

    def test_verified_zero_bill_still_charges_actual_billable_usage(self):
        quote = self.pending_bill()
        self.reconcile(quote, '0')
        self.assertEqual(self.execute_task(quote)['points_used'], '2.469134')
        self.assertEqual(self.adapter.calls, 1)

    def test_verified_zero_bill_prefers_pre_allowance_amount(self):
        quote = self.pending_bill()
        self.reconcile(quote, '0', '0.01')
        self.assertEqual(self.execute_task(quote)['points_used'], '2.000000')
        self.assertEqual(self.adapter.calls, 1)

    def test_bill_cannot_be_reassigned_or_changed_after_confirmation(self):
        quote = self.pending_bill()
        self.assert_code('SUPPLIER_BILL_TASK_MISMATCH', lambda: self.reconcile(quote, '0.01', provider='minimax'))
        self.assert_code('SUPPLIER_BILL_TASK_MISMATCH', lambda: self.reconcile(quote, '0.01', bill_ref='other-bill'))
        self.reconcile(quote, '0.01')
        self.assert_code('SUPPLIER_BILL_CONFLICT', lambda: self.reconcile(quote, '0.02'))
        self.assertEqual(self.execute_task(quote)['points_used'], '2.000000')

    def test_actual_cost_above_quote_is_preserved_for_review_not_silently_clipped(self):
        quote = self.pending_bill()
        self.assertEqual(self.reconcile(quote, '0.03')['status'], 'bill-review')
        result = self.execute_task(quote)
        self.assertTrue(result['billing_pending'])
        self.assertIn('result', result)
        self.assertNotIn('points_used', result)
        self.assertEqual(self.balance()['balance'], '1000.000000')
        self.assertEqual(self.adapter.calls, 1)

    def test_repeated_request_executes_and_debits_once(self):
        quote = self.quote()
        self.assertEqual(self.quote()['quote_id'], quote['quote_id'])
        first = self.execute_task(quote)
        self.assertEqual(self.execute_task(quote), first)
        self.assertEqual(self.adapter.calls, 1)

    def test_double_click_concurrent_run_claims_once(self):
        quote = self.quote()
        self.adapter.barrier = threading.Barrier(2)
        with ThreadPoolExecutor(2) as pool:
            a = pool.submit(self.execute_task, quote)
            while self.adapter.calls == 0:
                threading.Event().wait(.005)
            b = pool.submit(self.execute_task, quote)
            self.assertEqual(b.result()['status'], 'executing')
            self.adapter.barrier.wait(5)
            self.assertEqual(a.result()['status'], 'succeeded')
        self.assertEqual(self.adapter.calls, 1)

    def test_request_id_cannot_change_payload_or_feature(self):
        self.quote()
        self.assert_code('IDEMPOTENCY_CONFLICT', lambda: self.quote(payload={'text': 'changed'}))
        self.assert_code('IDEMPOTENCY_CONFLICT', lambda: self.quote(feature='classifier'))

    def test_personal_api_cannot_be_quoted_or_charged(self):
        self.assert_code('CUSTOMER_API_NOT_BILLABLE', lambda: self.quote(api_source='customer_api'))
        self.assertEqual(self.balance()['reserved_units'], 0)

    def test_platform_unavailable_does_not_make_supplier_call(self):
        self.enabled = False
        self.assert_code('PLATFORM_API_UNAVAILABLE', self.quote)
        self.assertEqual(self.adapter.calls, 0)

    def test_expired_quote_and_configuration_change_require_new_quote(self):
        quote = self.quote()
        self.adapter.configuration = 'different-model'
        self.assert_code('QUOTE_CONFIGURATION_CHANGED', lambda: self.execute_task(quote))
        self.adapter.configuration = 'synthetic-price-and-model-version'
        self.clock += 301
        self.assert_code('QUOTE_EXPIRED', lambda: self.execute_task(quote))
        self.assertEqual(self.balance()['reserved_units'], 0)

    def test_foreign_account_and_app_cannot_get_result(self):
        quote = self.quote()
        self.ledger.row['code_id'] = 'OTHER_OWNER'
        self.assert_code('QUOTE_NOT_FOUND', lambda: self.execute_task(quote))
        self.ledger.row['app_name'] = 'foreign'
        self.assert_code('APP_CREDENTIAL_MISMATCH', lambda: self.execute_task(quote))

    def test_definite_no_charge_failure_releases_points(self):
        self.adapter.error = NoChargeFailure()
        result = self.execute_task(self.quote())
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(self.balance()['balance'], '1000.000000')
        self.assertEqual(self.balance()['reserved_units'], 0)

    def test_unknown_failure_is_not_refunded_or_resubmitted(self):
        self.adapter.error = TimeoutError('private supplier error must not be returned')
        quote = self.quote()
        result = self.execute_task(quote)
        self.assertEqual(result['status'], 'unknown')
        self.assertNotIn('private supplier', json.dumps(result))
        self.assertEqual(self.balance()['reserved'], '4.000000')
        self.assertEqual(self.execute_task(quote)['status'], 'unknown')
        self.assertEqual(self.adapter.calls, 1)

    def test_settlement_failure_retries_ledger_only(self):
        self.fail_commit = True
        quote = self.quote()
        self.assertEqual(self.execute_task(quote)['status'], 'settling')
        self.fail_commit = False
        self.assertEqual(self.execute_task(quote)['status'], 'succeeded')
        self.assertEqual(self.adapter.calls, 1)

    def test_process_restart_does_not_repeat_supplier_call(self):
        self.adapter.error = TimeoutError()
        quote = self.quote()
        self.execute_task(quote)
        with sqlite3.connect(self.path) as conn:
            conn.execute("UPDATE aiml_generation_tasks SET status='executing' WHERE quote_id=?", (quote['quote_id'],))
        self.tasks = self.create()
        self.tasks.initialize()
        self.assertEqual(self.execute_task(quote)['status'], 'unknown')
        self.assertEqual(self.adapter.calls, 1)

    def test_prompt_and_result_are_encrypted_on_disk(self):
        quote = self.quote()
        self.execute_task(quote)
        raw = self.path.read_bytes()
        self.assertNotIn(b'synthetic-private-text', raw)
        self.assertNotIn(b'synthetic result', raw)

    def test_insufficient_balance_never_calls_supplier(self):
        with sqlite3.connect(self.ledger.db) as conn:
            conn.execute('UPDATE aiml_point_wallets SET balance_units=0')
        self.assert_code('INSUFFICIENT_POINTS', lambda: self.execute_task(self.quote()))
        self.assertEqual(self.adapter.calls, 0)


class BillingAmountTests(unittest.TestCase):
    def test_positive_actual_debit_takes_precedence(self):
        for amount in ('0.01', '0.03'):
            self.assertEqual(billing_amount('0.02', amount, '0.04'), (format(float(amount), '.8f'), 'supplier_debit'))

    def test_zero_debit_prefers_billable_amount_then_standard_usage(self):
        self.assertEqual(billing_amount('0.02', '0', '0.01'), ('0.01000000', 'billed_amount_zero_debit'))
        self.assertEqual(billing_amount('0.02', '0'), ('0.02000000', 'standard_tariff_zero_debit'))

    def test_unknown_debit_is_not_zero(self):
        self.assertEqual(billing_amount('0.02', None, '0.01'), (None, 'pending_supplier_bill'))

    def test_invalid_prices_are_rejected(self):
        for invalid in ('-1', 'NaN', '1e-2', 0.01, ''):
            with self.assertRaises(TaskError):
                billing_amount('0.02', invalid)


if __name__ == '__main__':
    unittest.main()
