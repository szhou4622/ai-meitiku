import copy
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from ai_media_points import APP, PREFIX, SCALE, PointsError, Settlement, amount
from ai_media_points_service import build_handler

CODE = 'AIML-P-' + 'A'*32
CODE2 = 'AIML-P-' + 'B'*32
TOKEN = 'test-only-internal-token-not-production'
OTHER = 'ProductOperationReport'


class SettlementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / 'central.sqlite3'
        with sqlite3.connect(self.db) as c:
            c.executescript('''
            CREATE TABLE activations(app_name TEXT,code_id TEXT,code_hash TEXT,bound_machine_code TEXT,
              credential_version INTEGER,device_credential_hash TEXT,binding_status TEXT,binding_role TEXT);
            CREATE TABLE redeem_codes(app_name TEXT,code_id TEXT,disabled INTEGER,
              credits INTEGER,unlimited INTEGER,duration_days INTEGER,license_type TEXT,expires_at TEXT,code_plaintext TEXT);
            CREATE TABLE point_accounts(app_name TEXT,code_id TEXT,balance INTEGER);
            CREATE TABLE por_precise_accounts(app_name TEXT,code_id TEXT,balance_units INTEGER);
            CREATE TABLE por_precise_transactions(app_name TEXT,logical_task_id TEXT,amount_units INTEGER);
            ''')
            for app, code in [(APP,'OWNER'),(APP,'OTHER_OWNER'),(OTHER,'POR_OWNER')]:
                c.execute('INSERT INTO activations VALUES(?,?,?,?,?,?,?,?)', (app,code,'hash','MACHINE',1,'credential','active','primary'))
                c.execute('INSERT INTO redeem_codes(app_name,code_id,disabled) VALUES(?,?,0)',(app,code))
            c.execute('INSERT INTO point_accounts VALUES(?,?,?)',(OTHER,'POR_OWNER',123))
            c.execute('INSERT INTO por_precise_accounts VALUES(?,?,?)',(OTHER,'POR_OWNER',123456789))
            c.execute('INSERT INTO por_precise_transactions VALUES(?,?,?)',(OTHER,'por-task',34567))
        self.row = dict(app_name=APP,code_id='OWNER',code_hash='hash',bound_machine_code='MACHINE',credential_version=1,
                        device_credential_hash='credential',binding_status='active',binding_role='primary')
        self.auth_headers = {'Authorization':'Bearer synthetic','X-Device-Credential':'synthetic'}
        self.internal_headers = {**self.auth_headers,'X-AIML-Settlement-Token':TOKEN}
        self.engine = Settlement(self.db, self.auth, TOKEN, True)
        self.engine.initialize()

    def tearDown(self):
        self.temp.cleanup()

    def auth(self, headers, allow_expired=False):
        if headers.get('Authorization') != 'Bearer synthetic' or headers.get('X-Device-Credential') != 'synthetic':
            raise PointsError('DEVICE_AUTH_FAILED','synthetic authentication failed',401)
        return self.row.copy()

    def call(self, action, **data):
        return self.engine.handle(action, {'app_name':APP,**data}, self.internal_headers)

    def issue(self, code=CODE, req='issue', paid='10'):
        return self.call('issue-code',code=code,request_id=req,paid_cny=paid)

    def funded(self):
        self.issue()
        self.call('redeem',code=CODE,request_id='redeem')

    def reserve(self, req='task', budget='1', source='platform_api', feature='schemes'):
        return self.call('reserve',request_id=req,budget_cny=budget,api_source=source,feature=feature)

    def settle(self, task, cost='0.12345678', bill='bill', action='commit', **overrides):
        data=dict(task_id=task['task_id'],cost_cny=cost,provider='volcengine',bill_ref=bill,attempt_id='attempt-1',billed_model='ep-test')
        data.update(overrides)
        return self.call(action,**data)

    def assert_code(self, code, fn):
        with self.assertRaises(PointsError) as caught:fn()
        self.assertEqual(caught.exception.code,code)

    def test_exact_actual_cost_200_preserves_small_amounts(self):
        self.funded();task=self.reserve();r=self.settle(task)
        self.assertEqual(r['points_used'],'24.691356')
        self.assertEqual(r['balance'],'975.308644')
        self.assertEqual(r['reserved'],'0.000000')
        self.assertEqual(amount('0.00000001',200),2)

    def test_recharge_one_yuan_100_points(self):
        r=self.issue(paid='1.25');self.assertEqual(r['points'],'125.000000')

    def legacy(self, app=APP, **overrides):
        values = dict(app_name=app,code_id='UNUSED_CARD',disabled=0,credits=1000,unlimited=0,
                      duration_days=0,license_type='standard',expires_at='',code_plaintext='AIM-AAAA-BBBB-CCCC')
        values.update(overrides)
        with sqlite3.connect(self.db) as conn:
            conn.execute('INSERT INTO redeem_codes(' + ','.join(values) + ') VALUES (' + ','.join('?' for _ in values) + ')',tuple(values.values()))
        return values['code_plaintext']

    def test_legacy_points_card_consumed_atomically_once(self):
        code=self.legacy()
        self.assertEqual(self.call('redeem',code=code,request_id='legacy-redeem')['balance_units'],1000*SCALE)
        self.assertTrue(self.call('redeem',code=code,request_id='legacy-redeem')['idempotent'])
        self.assertTrue(self.call('redeem',code=code,request_id='legacy-retry')['idempotent'])
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute('SELECT disabled FROM redeem_codes WHERE app_name=? AND code_id=?',(APP,'UNUSED_CARD')).fetchone()[0],1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM aiml_point_ledger WHERE kind='recharge'").fetchone()[0],1)
        self.row['code_id']='OTHER_OWNER'
        self.assert_code('REDEEM_CODE_USED',lambda:self.call('redeem',code=code,request_id='another-account'))

    def test_foreign_legacy_code_cannot_be_consumed(self):
        code=self.legacy(app=OTHER)
        self.assert_code('REDEEM_CODE_NOT_FOUND',lambda:self.call('redeem',code=code,request_id='foreign'))
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute('SELECT disabled FROM redeem_codes WHERE app_name=? AND code_id=?',(OTHER,'UNUSED_CARD')).fetchone()[0],0)

    def test_legacy_time_vip_unlimited_and_ambiguous_codes_rejected(self):
        for change in ({'duration_days':30},{'license_type':'vip'},{'unlimited':1},{'credits':0},{'expires_at':'2000-01-01'}):
            code=self.legacy(**change)
            self.assert_code('LEGACY_CODE_REVIEW_REQUIRED',lambda:self.call('redeem',code=code,request_id='bad-card'))
            with sqlite3.connect(self.db) as conn:
                self.assertEqual(conn.execute('SELECT disabled FROM redeem_codes WHERE app_name=? AND code_id=?',(APP,'UNUSED_CARD')).fetchone()[0],0)
                conn.execute('DELETE FROM redeem_codes WHERE app_name=? AND code_id=?',(APP,'UNUSED_CARD'))
        code=self.legacy();self.legacy(code_id='DUPLICATE_CARD')
        self.assert_code('LEGACY_CODE_REVIEW_REQUIRED',lambda:self.call('redeem',code=code,request_id='duplicate'))

    def test_legacy_bound_or_account_code_rejected(self):
        code=self.legacy()
        with sqlite3.connect(self.db) as conn:
            conn.execute('INSERT INTO point_accounts VALUES(?,?,?)',(APP,'UNUSED_CARD',0))
        self.assert_code('REDEEM_CODE_USED',lambda:self.call('redeem',code=code,request_id='bound-card'))

    def test_legacy_grant_failure_rolls_back_disabling_and_registration(self):
        code=self.legacy();self.call('balance')
        with sqlite3.connect(self.db) as conn:
            conn.execute('UPDATE aiml_point_wallets SET balance_units=1000000000000000 WHERE app_name=?',(APP,))
        self.assert_code('BALANCE_LIMIT',lambda:self.call('redeem',code=code,request_id='too-much'))
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute('SELECT disabled FROM redeem_codes WHERE app_name=? AND code_id=?',(APP,'UNUSED_CARD')).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM aiml_point_codes').fetchone()[0],0)

    def test_legacy_concurrent_redeem_only_one_grant(self):
        code=self.legacy()
        with ThreadPoolExecutor(max_workers=8) as pool:
            rows=list(pool.map(lambda i:self.call('redeem',code=code,request_id='legacy-'+str(i)),range(8)))
        self.assertEqual(sum(not r['idempotent'] for r in rows),1)
        self.assertEqual(self.call('balance')['balance_units'],1000*SCALE)

    def test_internal_issuance_cannot_bypass_legacy_registry(self):
        self.assert_code('INVALID_REDEEM_CODE',lambda:self.issue('AIM-AAAA-BBBB-CCCC'))

    def test_money_rejects_float_nan_negative_boolean_scientific(self):
        for value in (True,1,0.1,'NaN','-1','1e2',' 1','0.000000001','Infinity'):
            self.assert_code('INVALID_COST',lambda v=value:amount(v,200))

    def test_scope_exact_required_all_actions(self):
        for app in (None,'',OTHER,'AI-MEDIA-LIBRARY',' ai-media-library'):
            for action in ('balance','transactions','redeem','reserve','commit','release','issue-code'):
                self.assert_code('APP_SCOPE_MISMATCH',lambda a=app,b=action:self.engine.handle(b,{'app_name':a},self.internal_headers))

    def test_other_product_credential_cannot_spoof_app(self):
        self.row['app_name']=OTHER;self.row['code_id']='POR_OWNER'
        self.assert_code('APP_CREDENTIAL_MISMATCH',lambda:self.call('balance'))

    def test_internal_token_required_for_consumption_and_issuance(self):
        for action in ('issue-code','reserve','commit','release'):
            self.assert_code('INTERNAL_AUTH_REQUIRED',lambda a=action:self.engine.handle(a,{'app_name':APP},self.auth_headers))

    def test_no_auth_rejected(self):
        self.assert_code('DEVICE_AUTH_FAILED',lambda:self.engine.handle('balance',{'app_name':APP},{}))

    def test_no_grant_from_time_or_vip(self):
        self.assertEqual(self.call('balance')['balance'],'0.000000')

    def test_recharge_idempotency_and_used_code(self):
        self.issue();r=self.call('redeem',code=CODE,request_id='redeem')
        self.assertFalse(r['idempotent'])
        self.assertTrue(self.call('redeem',code=CODE,request_id='redeem')['idempotent'])
        self.assertTrue(self.call('redeem',code=CODE,request_id='new-retry')['idempotent'])
        self.row['code_id']='OTHER_OWNER'
        self.assert_code('REDEEM_CODE_USED',lambda:self.call('redeem',code=CODE,request_id='redeem'))

    def test_recharge_conflicting_request_rolls_back(self):
        self.funded();self.issue(CODE2,'issue-2')
        self.assert_code('IDEMPOTENCY_CONFLICT',lambda:self.call('redeem',code=CODE2,request_id='redeem'))
        self.assertEqual(self.call('balance')['balance'],'1000.000000')

    def test_issue_idempotency_and_conflicting_parameters(self):
        self.issue();self.assertTrue(self.issue()['idempotent'])
        self.assert_code('IDEMPOTENCY_CONFLICT',lambda:self.issue(paid='11'))
        self.assert_code('CODE_ALREADY_ISSUED',lambda:self.issue(req='another'))

    def test_reserve_idempotency(self):
        self.funded();a=self.reserve();b=self.reserve()
        self.assertEqual(a['task_id'],b['task_id']);self.assertTrue(b['idempotent'])
        self.assertEqual(b['available'],'800.000000')
        self.assert_code('IDEMPOTENCY_CONFLICT',lambda:self.reserve(budget='2'))

    def test_commit_replays_after_restart(self):
        self.funded();task=self.reserve();r=self.settle(task)
        self.engine=Settlement(self.db,self.auth,TOKEN,True)
        again=self.settle(task);self.assertTrue(again['idempotent'])
        self.assertEqual(r['balance_units'],again['balance_units'])

    def test_different_attempt_or_cost_cannot_rebill_task(self):
        self.funded();task=self.reserve();self.settle(task)
        for overrides in ({'cost_cny':'0.2'},{'attempt_id':'attempt-2'},{'billed_model':'other-model'}):
            self.assert_code('SETTLEMENT_CONFLICT',lambda o=overrides:self.settle(task,**o))

    def test_same_receipt_cannot_pay_for_two_tasks(self):
        self.funded();a=self.reserve('a');b=self.reserve('b');self.settle(a)
        self.assert_code('BILL_REFERENCE_USED',lambda:self.settle(b))
        self.assertEqual(self.call('balance')['reserved'],'200.000000')

    def test_zero_cost_release_idempotent(self):
        self.funded();task=self.reserve()
        self.settle(task,'0',action='release');self.assertTrue(self.settle(task,'0',action='release')['idempotent'])
        self.assertEqual(self.call('balance')['available'],'1000.000000')

    def test_failure_with_cost_cannot_release(self):
        self.funded();task=self.reserve()
        self.assert_code('COST_NOT_ZERO',lambda:self.settle(task,'0.1',action='release'))
        self.assertEqual(self.settle(task,'0.1')['points_used'],'20.000000')

    def test_over_budget_holds_funds(self):
        self.funded();task=self.reserve()
        self.assert_code('COST_EXCEEDS_BUDGET',lambda:self.settle(task,'1.000001'))
        self.assertEqual(self.call('balance')['reserved'],'200.000000')

    def test_consumption_off(self):
        self.funded();self.engine.consumption_enabled=False
        self.assert_code('CONSUMPTION_DISABLED',lambda:self.reserve())

    def test_customer_api_and_free_features_cannot_charge(self):
        self.funded()
        self.assert_code('CUSTOMER_API_NOT_BILLABLE',lambda:self.reserve(source='customer_api'))
        for feature in ('hotspots','video-download','viral-copy','viral-visuals','unknown'):
            self.assert_code('FEATURE_NOT_BILLABLE',lambda f=feature:self.reserve(feature=f))

    def test_reservation_concurrency_cannot_overspend(self):
        self.funded()
        def go(i):
            try:return self.reserve('task-'+str(i),budget='2')['task_id']
            except PointsError as e:return e.code
        with ThreadPoolExecutor(max_workers=12) as pool:r=list(pool.map(go,range(12)))
        self.assertEqual(r.count('INSUFFICIENT_POINTS'),10)
        self.assertEqual(self.call('balance')['available'],'200.000000')

    def test_concurrent_commit_only_debits_once(self):
        self.funded();task=self.reserve()
        with ThreadPoolExecutor(max_workers=12) as pool:r=list(pool.map(lambda _:self.settle(task),range(12)))
        self.assertEqual(sum(not x['idempotent'] for x in r),1)
        self.assertEqual(self.call('balance')['balance'],'975.308644')

    def test_binding_changes_before_transaction_rejected(self):
        with sqlite3.connect(self.db) as c:c.execute('UPDATE activations SET credential_version=2 WHERE app_name=?',(APP,))
        self.assert_code('DEVICE_CHANGED',lambda:self.call('balance'))

    def test_rebind_preserves_fractional_wallet(self):
        self.funded();task=self.reserve();self.settle(task)
        with sqlite3.connect(self.db) as c:c.execute('UPDATE activations SET bound_machine_code=?,credential_version=2 WHERE app_name=? AND code_id=?',('NEW',APP,'OWNER'))
        self.row.update(bound_machine_code='NEW',credential_version=2)
        self.assertEqual(self.call('balance')['balance'],'975.308644')

    def test_inflight_internal_settlement_survives_unbind(self):
        self.funded();task=self.reserve()
        with sqlite3.connect(self.db) as c:c.execute("UPDATE activations SET binding_status='unbound' WHERE app_name=?",(APP,))
        self.assertEqual(self.settle(task)['status'],'committed')
        self.assert_code('DEVICE_CHANGED',lambda:self.call('balance'))

    def test_client_cannot_submit_cost_or_account(self):
        for field in ('cost_cny','account_id','code_id','api_key','amount_units'):
            self.assert_code('UNEXPECTED_FIELDS',lambda f=field:self.call('balance',**{f:'x'}))

    def test_pending_reservations_not_automatically_released(self):
        self.funded();task=self.reserve()
        with sqlite3.connect(self.db) as c:c.execute("UPDATE aiml_point_tasks SET created_at='2000-01-01' WHERE app_name=?",(APP,))
        self.assertEqual(self.call('balance')['reserved'],'200.000000')

    def test_other_product_rows_and_schema_unchanged(self):
        def snapshot():
            with sqlite3.connect(self.db) as c:
                return {t:(c.execute('SELECT sql FROM sqlite_master WHERE name=?',(t,)).fetchone(),c.execute('SELECT * FROM '+t).fetchall()) for t in ('activations','redeem_codes','point_accounts','por_precise_accounts','por_precise_transactions')}
        before=snapshot();self.funded();self.settle(self.reserve());self.call('transactions')
        self.assertEqual(before,snapshot())

    def test_history_pagination_and_no_secret_or_receipt(self):
        self.funded();self.settle(self.reserve());r=self.call('transactions',limit=1)
        self.assertEqual(len(r['items']),1)
        self.assertNotIn('bill_ref',json.dumps(r));self.assertNotIn(CODE,json.dumps(r))
        n=self.call('transactions',before_sequence=r['next_before_sequence'],limit=1)
        self.assertNotEqual(r['items'][0]['sequence'],n['items'][0]['sequence'])

    def test_legacy_nonzero_not_silently_reset(self):
        with sqlite3.connect(self.db) as c:c.execute('INSERT INTO point_accounts VALUES(?,?,?)',(APP,'OWNER',2))
        self.assert_code('LEGACY_BALANCE_REVIEW_REQUIRED',lambda:self.call('balance'))

    def test_http_exact_scope_and_duplicate_keys_and_redaction(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),build_handler(self.engine))
        t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        def request(body,route='balance',headers=None):
            connection=HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            connection.request('POST',PREFIX+route,body,{'Content-Type':'application/json',**(headers or self.auth_headers)})
            response=connection.getresponse();data=json.loads(response.read());connection.close();return response.status,data
        try:
            self.assertEqual(request(json.dumps({'app_name':APP}))[0],200)
            self.assertEqual(request(json.dumps({'app_name':OTHER}))[0],403)
            self.assertEqual(request('{"app_name":"'+APP+'","app_name":"'+APP+'"}')[0],400)
            self.assertEqual(request(json.dumps({'app_name':APP}),'internal/reserve')[0],403)
            self.engine.authenticate=lambda *a,**k:(_ for _ in ()).throw(RuntimeError('SECRET-DO-NOT-RETURN'))
            status,data=request(json.dumps({'app_name':APP}));self.assertEqual(status,500)
            self.assertNotIn('SECRET',json.dumps(data))
        finally:server.shutdown();server.server_close();t.join()


if __name__=='__main__':unittest.main(verbosity=2)
