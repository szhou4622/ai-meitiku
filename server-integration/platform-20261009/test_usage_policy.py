import unittest
import test_ai_media_tasks as task_fixtures
from ai_media_tasks import TaskError
from volcengine_platform import SeedLite, MODEL


class UsagePolicyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = task_fixtures.TaskTests(); self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.calls = 0
        self.result = {'id':'synthetic-usage-policy', 'model':MODEL,
            'choices':[{'message':{'content':'synthetic result'}}],
            'usage':{'prompt_tokens':100,'completion_tokens':10,'total_tokens':110,
                     'prompt_tokens_details':{'cached_tokens':20}}}
        def request(body):
            self.calls += 1
            return 200, self.result
        self.adapter = SeedLite('synthetic-secret', request=request)
        self.fixture.tasks.adapters['volcengine'] = self.adapter

    def quote(self):
        return self.fixture.quote(payload={'messages':[{'role':'user','content':'synthetic'}]})

    def pending(self):
        original = self.adapter.quote
        self.adapter.quote = lambda *args: {**original(*args),
            'billing_basis':'supplier_debit_with_zero_fallback', 'price_version':'seed-2.1-lite-standard-20261009'}
        quote = self.quote()
        self.assertEqual(self.fixture.execute_task(quote)['status'], 'awaiting-bill')
        return quote

    def test_new_tasks_settle_exact_cached_usage_without_bill_or_discount(self):
        quoted = self.quote()
        self.assertEqual(quoted['billing_basis'], 'supplier_usage_tariff')
        result = self.fixture.execute_task(quoted)
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['points_used'], '0.018840')
        self.fixture.execute_task(quoted)
        self.assertEqual(self.calls, 1)

    def test_free_supplier_allowance_does_not_reduce_customer_usage_points(self):
        execute = self.adapter.execute
        def free_allowance(*args):
            result, receipt = execute(*args)
            receipt['supplier_debit_cny'] = '0'
            return result, receipt
        self.adapter.execute = free_allowance
        quoted = self.quote(); result = self.fixture.execute_task(quoted)
        self.assertEqual(result['points_used'], '0.018840')
        self.assertEqual(self.fixture.balance()['balance'], '999.981160')
        self.fixture.execute_task(quoted); self.assertEqual(self.calls, 1)

    def test_migration_settles_existing_receipt_without_regeneration(self):
        quote = self.pending()
        migrated = self.fixture.tasks.adopt_usage_policy(quote['quote_id'])
        self.assertEqual(migrated['status'], 'settling')
        self.assertEqual(migrated['billing_basis'], 'supplier_usage_tariff')
        self.fixture.tasks.adopt_usage_policy(quote['quote_id'])
        result = self.fixture.execute_task(quote)
        self.assertEqual(result['points_used'], '0.018840')
        self.assertEqual(self.fixture.balance()['reserved_units'], 0)
        self.assertEqual(self.calls, 1)

    def test_migration_refuses_unknown_missing_usage_and_completed_tasks(self):
        quote = self.pending()
        with self.fixture.tasks.transaction() as conn:
            self.result['usage']['total_tokens'] = 111
            conn.execute('UPDATE aiml_generation_tasks SET result=? WHERE quote_id=?',
                         (self.fixture.tasks.seal(self.result), quote['quote_id']))
        with self.assertRaises(TaskError): self.fixture.tasks.adopt_usage_policy(quote['quote_id'])
        for status in ('unknown','quoted','succeeded'):
            self.fixture.tasks.update(quote['quote_id'],status=status)
            with self.assertRaises(TaskError): self.fixture.tasks.adopt_usage_policy(quote['quote_id'])
        self.assertEqual(self.calls, 1)

    def test_supplier_bill_cannot_reprice_a_usage_settled_task(self):
        quote = self.quote(); self.fixture.execute_task(quote)
        with self.assertRaises(TaskError):
            self.fixture.tasks.confirm_supplier_bill(quote['quote_id'],'volcengine','synthetic-usage-policy','0')

    def test_terminal_failure_without_usage_preserves_reservation_not_a_zero_bill(self):
        from ai_media_tasks import SupplierTaskFailure
        self.adapter.execute = lambda *args: (_ for _ in ()).throw(SupplierTaskFailure({'status':'TIMEOUT_FAILED','error_code':'InternalError','bill_ref':'synthetic-failed-job'}))
        quote = self.quote(); result = self.fixture.execute_task(quote)
        self.assertEqual(result['status'], 'failed'); self.assertTrue(result['billing_pending'])
        self.assertGreater(self.fixture.balance()['reserved_units'], 0)
        self.fixture.execute_task(quote)
        with self.fixture.tasks.transaction() as db:
            receipt = self.fixture.tasks.unseal(db.execute('SELECT receipt FROM aiml_generation_tasks WHERE quote_id=?',(quote['quote_id'],)).fetchone()[0])
        self.assertIsNone(receipt['supplier_debit_cny']); self.assertIsNone(receipt['cost_cny'])
        self.assertNotIn('InternalError', str(result))

    def test_failed_task_exact_paid_or_zero_bill_settles_once_and_never_runs_again(self):
        from ai_media_tasks import SupplierTaskFailure
        calls = []
        def fail(*args):
            calls.append(args[2]); raise SupplierTaskFailure({'status':'PROCESS_FAILED','bill_ref':'failed-job:' + args[2]})
        self.adapter.execute = fail
        evidence = {'source':'DescribeInstanceBill','bill_sha256':'a' * 64}
        for amount in ('0.00200000', '0'):
            quote = self.fixture.quote(request='failure-'+amount,payload={'messages':[{'role':'user','content':'test'}]})
            pending = self.fixture.execute_task(quote); self.assertTrue(pending['billing_pending'])
            bill_ref = 'failed-job:' + quote['quote_id']
            with self.assertRaises(TaskError): self.fixture.tasks.confirm_supplier_bill(quote['quote_id'],'volcengine',bill_ref,amount)
            with self.assertRaises(TaskError): self.fixture.tasks.confirm_supplier_bill(quote['quote_id'],'volcengine','wrong-job',amount,billing_evidence=evidence)
            self.fixture.tasks.confirm_supplier_bill(quote['quote_id'],'volcengine',bill_ref,amount,billing_evidence=evidence)
            result = self.fixture.execute_task(quote)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['points_used'], '0.400000' if amount != '0' else '0.000000')
            self.assertEqual(self.fixture.balance()['reserved_units'], 0)
            self.fixture.execute_task(quote)
            self.fixture.tasks.confirm_supplier_bill(quote['quote_id'],'volcengine',bill_ref,amount,billing_evidence=evidence)
        self.assertEqual(len(calls), 2); self.assertEqual(self.fixture.balance()['balance'], '999.600000')

    def test_explicit_legacy_waiver_releases_once_without_claiming_supplier_was_free(self):
        adapter = task_fixtures.Adapter(); adapter.error = TimeoutError()
        self.fixture.tasks.adapters['minimax'] = adapter
        q = self.fixture.quote(feature='voice',provider='minimax')
        self.assertEqual(self.fixture.execute_task(q)['status'],'unknown')
        self.assertGreater(self.fixture.balance()['reserved_units'],0)
        self.fixture.tasks.waive_legacy_unknown(q['quote_id'])
        self.assertEqual(self.fixture.execute_task(q)['status'],'failed')
        self.fixture.tasks.waive_legacy_unknown(q['quote_id']);self.fixture.execute_task(q)
        self.assertEqual(self.fixture.balance()['reserved_units'],0)
        self.assertEqual(self.fixture.balance()['balance'],'1000.000000')
        self.assertEqual(adapter.calls,1)
        with self.fixture.tasks.transaction() as c:
            receipt=self.fixture.tasks.unseal(c.execute('SELECT receipt FROM aiml_generation_tasks WHERE quote_id=?',(q['quote_id'],)).fetchone()[0])
        self.assertTrue(receipt['supplier_cost_unknown'])
        self.assertEqual(receipt['settlement_basis'],'platform_waiver_legacy_unknown')

    def test_waiver_does_not_apply_to_new_or_recoverable_tasks(self):
        adapter=task_fixtures.Adapter();adapter.error=TimeoutError();self.fixture.tasks.adapters['minimax']=adapter
        q=self.fixture.quote(feature='voice',provider='minimax');self.fixture.execute_task(q)
        adapter.checkpoint=lambda _: {'submitted':True}
        with self.assertRaises(TaskError):self.fixture.tasks.waive_legacy_unknown(q['quote_id'])
        adapter.checkpoint=lambda _:None
        with self.fixture.tasks.transaction() as c:c.execute('UPDATE aiml_generation_tasks SET created_at=? WHERE quote_id=?',(1791889581,q['quote_id']))
        with self.assertRaises(TaskError):self.fixture.tasks.waive_legacy_unknown(q['quote_id'])


if __name__ == '__main__': unittest.main()
