import datetime as dt
import tempfile
import unittest
from pathlib import Path
from ai_media_tasks import MediaTasks, APP
from volcengine_platform import SeedLite, MODEL
from volcengine_reconcile import VolcengineReconciler, MODEL_NAME, MODEL_VERSION, allocate
from decimal import Decimal


class BillingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.calls, self.settlements = [], []
        self.now = dt.datetime(2026, 10, 13, 9, 29, tzinfo=dt.timezone.utc).timestamp()
        def execute(body):
            self.calls.append(body)
            return 200, {'model': MODEL, 'id': 'synthetic-receipt',
                'choices': [{'message': {'content': 'synthetic result'}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 305, 'completion_tokens': 81, 'total_tokens': 386,
                          'prompt_tokens_details': {'cached_tokens': 0}}}
        def settlement(action, data, headers):
            self.settlements.append(action)
            return {'task_id': 'synthetic-task', 'status': 'committed' if action == 'commit' else 'reserved'}
        self.adapter = SeedLite('synthetic-credential', request=execute, allow_images=False)
        # These tests retain historical actual-debit reconciliation behavior;
        # newly quoted production tasks now use the approved usage tariff.
        original_quote = self.adapter.quote
        self.adapter.quote = lambda *args: {**original_quote(*args), 'billing_basis':'supplier_debit_with_zero_fallback'}
        self.tasks = MediaTasks(Path(self.tmp.name) / 'tasks.db', b'k' * 32,
            lambda headers, **kw: {'app_name': APP, 'code_id': 'synthetic-account'}, settlement,
            {'volcengine': self.adapter}, lambda: True, lambda: self.now, {'prompt-library'})
        self.tasks.initialize()
        quote = self.tasks.handle('quote', {'app_name': APP, 'request_id': 'synthetic-request',
            'feature': 'prompt-library', 'provider': 'volcengine', 'api_source': 'platform_api',
            'payload': {'messages': [{'role': 'user', 'content': '字' * 400}], 'max_tokens': 100}}, {})
        self.id = quote['quote_id']
        self.tasks.handle('run', {'app_name': APP, 'quote_id': self.id, 'confirm_run': True}, {})
        self.record = {'AccountID': '1234', 'ApikeyID': 'id-synthetic', 'ModelName': MODEL_NAME, 'ModelVersion': MODEL_VERSION,
            'Day': '2026-10-13', 'Hour': '17', 'BillingStatus': 'free_for_free_quota',
            'InputTokens': '305', 'CacheTokensHit': '0', 'OutputTokens': '81', 'TotalTokens': '386', 'ReqCnt': '1'}
        self.bills = []
        self.detail_bills = []
        self.account_record = None
        self.tasks.billing_resolver = VolcengineReconciler(self, 'id-synthetic', self.adapter.configuration, lambda: self.now + 600)

    def tearDown(self): self.tmp.cleanup()

    def query(self, action, payload):
        if action == 'GetInferenceUsage':
            row = self.account_record if self.account_record and payload['Filters'][0]['Values'] == [] else self.record
            return {'Fields': [{'Name': k} for k in row], 'Data': [list(row.values())], 'DataCount': 1}
        if action == 'ListBillDetail':
            self.assertEqual(payload['OwnerID'], [1234])
            return {'List': self.detail_bills, 'Total': len(self.detail_bills), 'Warning': ''}
        self.assertEqual(payload['SplitItemID'], 'id-synthetic')
        return {'List': self.bills, 'Total': len(self.bills), 'Warning': ''}

    def status(self): return self.tasks.handle('status', {'app_name': APP, 'quote_id': self.id}, {})

    def test_confirmed_free_usage_settles_tariff_once_without_another_supplier_call(self):
        self.assertEqual(self.status()['points_used'], '0.092540')
        self.assertEqual(self.status()['points_used'], '0.092540')
        self.assertEqual(self.settlements, ['reserve', 'commit'])
        self.assertEqual(len(self.calls), 1)

    def test_other_key_wrong_model_extra_usage_or_partial_counts_never_settle(self):
        for key, value in [('ApikeyID', 'wrong-key'), ('ModelVersion', 'old-version'), ('ReqCnt', '2'), ('OutputTokens', '80')]:
            original = self.record[key]; self.record[key] = value
            self.tasks.billing_resolver.attempts.clear()
            self.assertEqual(self.status()['status'], 'awaiting-bill')
            self.record[key] = original
        self.assertEqual(self.settlements, ['reserve'])

    def test_missing_bill_is_not_zero(self):
        self.record['BillingStatus'] = 'normal'
        self.assertEqual(self.status()['status'], 'awaiting-bill')
        self.assertEqual(self.settlements, ['reserve'])

    def test_verified_zero_debit_uses_pre_allowance_split_bill_amount(self):
        self.record['BillingStatus'] = 'normal'
        for kind, count, amount in [('input', '0.305', '0.000244'), ('output', '0.081', '0.000219')]:
            self.bills.append({'SplitItemID': 'id-synthetic', 'Product': 'ark_bd',
                'ConfigurationCode': 'Doubao_Seed_2.1_lite', 'ExpenseTime': '2026-10-13 17:25:00~2026-10-13 17:30:00',
                'ChargeItemCode': 'Doubao_Seed_2.1_lite_infer_' + kind + '_cn-beijing_realtime',
                'Currency': 'CNY', 'Unit': '千tokens', 'SplitBillDetailId': 'synthetic-' + kind,
                'DeductionCount': '0', 'SplitItemAmount': count, 'PayableAmount': '0', 'DiscountBillAmount': amount})
        self.assertEqual(self.status()['points_used'], '0.092600')
        self.assertEqual(len(self.calls), 1)

    def test_positive_supplier_debit_wins_over_tariff_and_billed_amount(self):
        self.record['BillingStatus'] = 'normal'
        for kind, usage, charge in [('input', '0.305', '0.000100'), ('output', '0.081', '0.000200')]:
            self.bills.append({'SplitItemID': 'id-synthetic', 'Product': 'ark_bd',
                'ConfigurationCode': 'Doubao_Seed_2.1_lite', 'ExpenseTime': '2026-10-13 17:25:00~2026-10-13 17:30:00',
                'ChargeItemCode': 'Doubao_Seed_2.1_lite_infer_' + kind + '_cn-beijing_realtime',
                'Currency': 'CNY', 'Unit': '千tokens', 'SplitBillDetailId': 'synthetic-' + kind,
                'DeductionCount': '0', 'SplitItemAmount': usage, 'PayableAmount': charge, 'DiscountBillAmount': '0.000400'})
        result = self.status()
        self.assertEqual(result['points_used'], '0.060000')
        self.assertEqual(result['settlement_basis'], 'supplier_debit')
        with self.tasks.transaction() as conn:
            receipt = self.tasks.unseal(conn.execute('SELECT receipt FROM aiml_generation_tasks WHERE quote_id=?', (self.id,)).fetchone()['receipt'])
        self.assertEqual(receipt['billing_evidence']['source'], 'ListSplitBillDetail')

    def test_allocation_preserves_total_and_is_stable(self):
        values = allocate('0.00000005', [('a', Decimal(1)), ('b', Decimal(1)), ('c', Decimal(1))])
        self.assertEqual(sum(Decimal(v) for v in values.values()), Decimal('0.00000005'))
        self.assertEqual(values, {'a': '0.00000002', 'b': '0.00000002', 'c': '0.00000001'})

    def details(self):
        self.record['BillingStatus'] = 'normal'
        for kind, usage, price in [('input', '0.305', '0.000800'), ('output', '0.081', '0.002700')]:
            self.detail_bills.append({'OwnerID': '1234', 'Product': 'ark_bd',
                'ConfigurationCode': 'Doubao_Seed_2.1_lite', 'ExpenseBeginTime': '2026-10-13 17:25:00',
                'ExpenseEndTime': '2026-10-13 17:30:00', 'ChargeItemCode': 'Doubao_Seed_2.1_lite_infer_' + kind + '_cn-beijing_realtime',
                'Currency': 'CNY', 'Unit': '千tokens', 'BillDetailId': 'synthetic-' + kind,
                'DeductionCount': usage, 'Count': usage, 'PayableAmount': '0', 'DiscountBillAmount': '0',
                'Price': price, 'PriceUnit': '千tokens', 'BillingFunction': '固定单价', 'DiscountBizBillingFunction': '-'})

    def test_detailed_bills_with_complete_allowance_use_verified_before_allowance_price(self):
        self.details()
        result = self.status()
        self.assertEqual(result['points_used'], '0.092540')
        self.assertEqual(result['settlement_basis'], 'billed_amount_zero_debit')
        self.assertEqual(self.settlements, ['reserve', 'commit'])

    def test_account_bill_fallback_rejects_other_key_version_owner_and_partial_usage(self):
        self.details()
        for field, value in [('ApikeyID', 'other-key'), ('ModelVersion', 'other-version'), ('OutputTokens', '80')]:
            self.account_record = {**self.record, field: value}
            self.tasks.billing_resolver.attempts.clear()
            self.assertEqual(self.status()['status'], 'awaiting-bill')
        self.account_record = None
        self.detail_bills[0]['OwnerID'] = 'other-owner'
        self.tasks.billing_resolver.attempts.clear()
        self.assertEqual(self.status()['status'], 'awaiting-bill')
        self.assertEqual(self.settlements, ['reserve'])


if __name__ == '__main__': unittest.main()
