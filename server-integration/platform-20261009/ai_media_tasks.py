"""Media-only quote, explicit consent, supplier execution and durable settlement.

Quotes are server calculated. There is no client budget or default task ceiling.
Provider adapters must supply validated pricing and authoritative usage receipts.
Unknown supplier outcomes retain the reservation and never repeat the paid call.
"""
import base64
import hashlib
import json
import re
import secrets
import sqlite3
import time
import threading
from contextlib import contextmanager
from decimal import Decimal

APP = 'ai-media-library'
BILLING_BASIS = 'supplier_debit_with_zero_fallback'
FEATURE_PROVIDERS = {
    'schemes': {'volcengine'}, 'classifier': {'volcengine'},
    'prompt-library': {'volcengine'}, 'voice': {'minimax'},
    'subtitle-removal': {'aliyun'},
}


class TaskError(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status
        super().__init__(code)


class NoChargeFailure(Exception):
    """Only an adapter with definite evidence of no supplier charge may raise this."""


class SupplierTaskFailure(Exception):
    """Confirmed processing failure; neither usage nor supplier debit is implied."""
    def __init__(self, evidence):
        self.evidence = evidence
        super().__init__('SUBTITLE_TASK_FAILED')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def money(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?', value):
        raise TaskError('INVALID_SERVER_PRICE', 503)
    try:
        result = Decimal(value)
        if not result.is_finite() or result < 0 or result > 10000000 or result.as_tuple().exponent < -8:
            raise ValueError()
    except Exception:
        raise TaskError('INVALID_SERVER_PRICE', 503) from None
    return result


def billing_amount(standard_tariff_cny, supplier_debit_cny, billed_amount_cny=None):
    """Verified supplier deduction wins; confirmed zero uses actual billable usage.

    None means the bill has not been obtained. It must never be coerced to zero.
    A server-side pre-allowance billed amount is preferable to the tariff
    calculation when available. Free allowances do not make positive usage free.
    """
    standard = money(standard_tariff_cny)
    billed = money(billed_amount_cny) if billed_amount_cny is not None else None
    if supplier_debit_cny is None:
        return None, 'pending_supplier_bill'
    debit = money(supplier_debit_cny)
    if debit > 0:
        return format(debit, '.8f'), 'supplier_debit'
    if billed is not None and billed > 0:
        return format(billed, '.8f'), 'billed_amount_zero_debit'
    return format(standard, '.8f'), 'standard_tariff_zero_debit'


class MediaTasks:
    def __init__(self, db_path, encryption_key, authenticate, settlement, adapters,
                 consumption_enabled=lambda: False, clock=time.time, allowed_features=None, billing_resolver=None):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        self.db_path, self.cipher = str(db_path), AESGCM(encryption_key)
        self.authenticate, self.settlement, self.adapters = authenticate, settlement, adapters
        self.consumption_enabled, self.clock = consumption_enabled, clock
        self.allowed_features = frozenset(FEATURE_PROVIDERS if allowed_features is None else allowed_features)
        self.billing_resolver = billing_resolver

    def initialize(self):
        with self.transaction() as conn:
            conn.execute('''CREATE TABLE IF NOT EXISTS aiml_generation_tasks (
              quote_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_id TEXT NOT NULL,
              fingerprint TEXT NOT NULL, spec TEXT NOT NULL, created_at REAL NOT NULL,
              expires_at REAL NOT NULL, status TEXT NOT NULL, settlement_id TEXT,
              receipt TEXT, result TEXT, error_code TEXT, UNIQUE(account_id,request_id))''')
        self.recover_pending()

    def recover_pending(self):
        with self.transaction() as conn:
            # The previous process might have sent a paid call before it exited.
            conn.execute("UPDATE aiml_generation_tasks SET status='unknown',error_code='SUPPLIER_OUTCOME_UNKNOWN' WHERE status='executing'")
            conn.execute("UPDATE aiml_generation_tasks SET status='reserve-failed' WHERE status='reserving'")
            conn.execute("UPDATE aiml_generation_tasks SET status='settling' WHERE status='settlement-running'")

    @contextmanager
    def transaction(self):
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def seal(self, value):
        nonce = secrets.token_bytes(12)
        return base64.b64encode(nonce + self.cipher.encrypt(nonce, canonical(value).encode(), APP.encode())).decode()

    def unseal(self, value):
        raw = base64.b64decode(value, validate=True)
        return json.loads(self.cipher.decrypt(raw[:12], raw[12:], APP.encode()))

    def identity(self, headers):
        identity = self.authenticate(headers, allow_expired=False)
        if identity.get('app_name') != APP or not identity.get('code_id'):
            raise TaskError('APP_CREDENTIAL_MISMATCH', 403)
        return identity['code_id']

    def read(self, conn, quote_id, account):
        if not isinstance(quote_id, str) or len(quote_id) != 40:
            raise TaskError('INVALID_QUOTE', 400)
        row = conn.execute('SELECT * FROM aiml_generation_tasks WHERE quote_id=? AND account_id=?',
                           (quote_id, account)).fetchone()
        if not row:
            raise TaskError('QUOTE_NOT_FOUND', 404)
        return row

    def public(self, row):
        spec = self.unseal(row['spec'])
        data = {'ok': True, 'app_name': APP, 'quote_id': row['quote_id'],
                'status': row['status'], 'feature': spec['feature'], 'provider': spec['provider'],
                'points': format(money(spec['display_cny']) * 200, '.6f'),
                'pricing_kind': spec['pricing_kind'], 'price_version': spec['price_version'],
                'billing_basis': spec.get('billing_basis', 'standard_tariff_usage'),
                'expires_at': row['expires_at'], 'error_code': row['error_code']}
        if spec['provider'] == 'aliyun':
            adapter = self.adapters.get('aliyun')
            if adapter and hasattr(adapter, 'task_progress'):
                data['transfer'] = adapter.task_progress(row['quote_id'])
        if row['status'] in ('failed', 'failed-awaiting-bill', 'bill-review') and row['receipt']:
            receipt = self.unseal(row['receipt'])
            if row['status'] == 'failed-awaiting-bill' or (row['status'] == 'bill-review' and receipt.get('failure_evidence')):
                data['status'] = 'failed'; data['billing_pending'] = True
            elif row['status'] == 'failed' and receipt.get('cost_cny') is not None:
                data['points_used'] = format(money(receipt['cost_cny']) * 200, '.6f')
        if row['status'] == 'succeeded':
            receipt = self.unseal(row['receipt'])
            data['points_used'] = format(money(receipt['cost_cny']) * 200, '.6f')
            data['result'] = self.unseal(row['result'])
            adapter = self.adapters.get(spec['provider'])
            if adapter and hasattr(adapter, 'public_result'):
                data['result'] = adapter.public_result(data['result'], row['quote_id'])
            data['settlement_basis'] = receipt.get('settlement_basis', 'standard_tariff_usage')
        elif row['status'] in ('awaiting-bill', 'bill-review') and row['result']:
            # Generation succeeded. Billing is pending, not a supplier timeout;
            # retain the result without encouraging another paid generation.
            data['result'] = self.unseal(row['result'])
            adapter = self.adapters.get(spec['provider'])
            if adapter and hasattr(adapter, 'public_result'):
                data['result'] = adapter.public_result(data['result'], row['quote_id'])
            data['billing_pending'] = True
        return data

    def quote(self, data, account):
        if set(data) != {'app_name', 'request_id', 'feature', 'provider', 'api_source', 'payload'}:
            raise TaskError('INVALID_QUOTE_REQUEST', 400)
        feature, provider, request_id = data['feature'], data['provider'], data['request_id']
        if data['api_source'] != 'platform_api':
            raise TaskError('CUSTOMER_API_NOT_BILLABLE', 409)
        if not isinstance(feature, str) or not isinstance(provider, str) or provider not in FEATURE_PROVIDERS.get(feature, set()):
            raise TaskError('FEATURE_PROVIDER_MISMATCH', 400)
        if feature not in self.allowed_features:
            raise TaskError('PLATFORM_FEATURE_UNAVAILABLE', 503)
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128 or not request_id.isascii():
            raise TaskError('INVALID_REQUEST_ID', 400)
        if not self.consumption_enabled() or provider not in self.adapters:
            raise TaskError('PLATFORM_API_UNAVAILABLE', 503)
        fp = fingerprint(data)
        with self.transaction() as conn:
            existing = conn.execute('SELECT * FROM aiml_generation_tasks WHERE account_id=? AND request_id=?',
                                    (account, request_id)).fetchone()
            if existing:
                if existing['fingerprint'] != fp:
                    raise TaskError('IDEMPOTENCY_CONFLICT')
                return self.public(existing)
        # Adapter validates every supplier parameter and snapshots its price version.
        spec = self.adapters[provider].quote(feature, data['payload'], account)
        if set(spec) - {'billing_basis'} != {'display_cny', 'pricing_kind', 'price_version', 'model', 'payload', 'configuration'}:
            raise TaskError('INVALID_SERVER_QUOTE', 503)
        if (spec['pricing_kind'] not in ('fixed', 'estimate') or money(spec['display_cny']) <= 0):
            raise TaskError('INVALID_SERVER_QUOTE', 503)
        basis = spec.get('billing_basis', BILLING_BASIS)
        if basis not in (BILLING_BASIS, 'supplier_usage_tariff'):
            raise TaskError('INVALID_BILLING_BASIS', 503)
        spec = {**spec, 'feature': feature, 'provider': provider, 'billing_basis': basis}
        with self.transaction() as conn:
            # A competing identical quote can finish the adapter calculation first.
            conn.execute("INSERT OR IGNORE INTO aiml_generation_tasks VALUES (?,?,?,?,?,?,?,'quoted',NULL,NULL,NULL,NULL)",
                         (secrets.token_hex(20), account, request_id, fp, self.seal(spec), self.clock(), self.clock() + 300))
            row = conn.execute('SELECT * FROM aiml_generation_tasks WHERE account_id=? AND request_id=?',
                               (account, request_id)).fetchone()
            if row['fingerprint'] != fp:
                raise TaskError('IDEMPOTENCY_CONFLICT')
            return self.public(row)

    def status(self, quote_id, account):
        recover = None
        with self.transaction() as conn:
            row = self.read(conn, quote_id, account)
            if row['status'] == 'unknown':
                spec = self.unseal(row['spec'])
                adapter = self.adapters.get(spec['provider'])
                resumable = (adapter and adapter.configuration == spec['configuration'] and
                    (spec['provider'] == 'aliyun' and adapter.checkpoint(quote_id) and
                     getattr(adapter, 'recovery_ready', lambda _: True)(quote_id) or
                     spec['provider'] == 'minimax' and getattr(adapter, 'resumable', lambda _: False)(quote_id)))
                if resumable:
                    conn.execute("UPDATE aiml_generation_tasks SET status='executing' WHERE quote_id=? AND status='unknown'", (quote_id,))
                    recover = (adapter, spec, row['created_at'])
                    row = self.read(conn, quote_id, account)
            result = self.public(row)
        if recover:
            threading.Thread(target=self.resume_accepted, args=(quote_id, *recover), daemon=True).start()
        return result

    def resume_accepted(self, quote_id, adapter, spec, started):
        try:
            result, receipt = adapter.resume(spec, quote_id)
            _, status = self.record_execution(quote_id, spec, result, receipt, started)
            if status == 'settlement-running': self.update(quote_id, status='settling')
        except SupplierTaskFailure as exc:
            self.record_failed_usage(quote_id, exc.evidence)
        except NoChargeFailure:
            receipt = {'cost_cny': '0', 'bill_ref': 'no-charge:' + quote_id, 'billed_model': spec['model'], 'action': 'release',
                       'billing_basis': BILLING_BASIS, 'standard_tariff_cny': '0', 'supplier_debit_cny': '0',
                       'settlement_basis': 'no_charge_failure'}
            self.update(quote_id, status='settling', receipt=self.seal(receipt), error_code='SUPPLIER_REJECTED_NO_CHARGE')
        except Exception as exc:
            if hasattr(adapter, 'recovery_failed'): adapter.recovery_failed(quote_id, exc)
            self.update(quote_id, status='unknown', error_code=exc.code if isinstance(exc, TaskError) else 'SUPPLIER_OUTCOME_UNKNOWN')

    def update(self, quote_id, **fields):
        if set(fields) - {'status', 'settlement_id', 'receipt', 'result', 'error_code'}:
            raise ValueError('invalid internal state update')
        with self.transaction() as conn:
            conn.execute('UPDATE aiml_generation_tasks SET ' + ','.join(k + '=?' for k in fields) + ' WHERE quote_id=?',
                         (*fields.values(), quote_id))

    def record_failed_usage(self, quote_id, evidence):
        # Failed tasks use exact supplier billing evidence. No bill is neither
        # a confirmed zero debit nor authority to charge the quoted estimate.
        with self.transaction() as db:
            row = db.execute('SELECT spec,created_at FROM aiml_generation_tasks WHERE quote_id=?', (quote_id,)).fetchone()
        spec = self.unseal(row['spec'])
        receipt = {'action': 'pending', 'cost_cny': None, 'supplier_debit_cny': None,
                   'standard_tariff_cny': None, 'bill_ref': evidence['bill_ref'],
                   'billed_model': spec['model'], 'billing_basis': spec['billing_basis'],
                   'settlement_basis': 'failed_supplier_bill', 'execution_started': row['created_at'],
                   'failure_evidence': evidence, 'observed_at': self.clock()}
        self.update(quote_id, status='failed-awaiting-bill', receipt=self.seal(receipt), error_code='SUBTITLE_TASK_FAILED')

    def record_execution(self, quote_id, spec, result, receipt, started):
        required = {'standard_tariff_cny', 'supplier_debit_cny', 'bill_ref', 'billed_model'}
        if not isinstance(receipt, dict) or not required <= set(receipt) or set(receipt) - required - {'billed_amount_cny'}:
            raise TaskError('SUPPLIER_RECEIPT_UNVERIFIED', 503)
        if spec.get('billing_basis') == 'supplier_usage_tariff':
            cost, basis = format(money(receipt['standard_tariff_cny']), '.8f'), 'supplier_usage_tariff'
        else:
            cost, basis = billing_amount(receipt['standard_tariff_cny'], receipt['supplier_debit_cny'], receipt.get('billed_amount_cny'))
        if receipt.get('billed_amount_cny') is not None:
            receipt['billed_amount_cny'] = format(money(receipt['billed_amount_cny']), '.8f')
        receipt = {**receipt, 'execution_started': started,
                   'execution_finished': self.clock(), 'action': 'commit', 'billing_basis': spec['billing_basis'],
                   'cost_cny': cost, 'settlement_basis': basis}
        status = 'awaiting-bill' if cost is None else 'bill-review' if money(cost) > money(spec['display_cny']) else 'settlement-running'
        error_code = 'SUPPLIER_BILL_PENDING' if cost is None else 'COST_EXCEEDS_QUOTE' if status == 'bill-review' else None
        self.update(quote_id, status=status, receipt=self.seal(receipt), result=self.seal(result), error_code=error_code)
        return receipt, status

    def run(self, data, account, headers):
        if set(data) != {'app_name', 'quote_id', 'confirm_run'} or data['confirm_run'] is not True:
            raise TaskError('RUN_CONFIRMATION_REQUIRED', 400)
        quote_id = data['quote_id']
        with self.transaction() as conn:
            row = self.read(conn, quote_id, account)
            spec = self.unseal(row['spec'])
            if row['status'] in ('quoted', 'reserve-failed'):
                if row['status'] == 'quoted' and self.clock() >= row['expires_at']:
                    raise TaskError('QUOTE_EXPIRED')
                if not self.consumption_enabled():
                    raise TaskError('CONSUMPTION_DISABLED', 503)
                if spec['feature'] not in self.allowed_features:
                    raise TaskError('PLATFORM_FEATURE_UNAVAILABLE', 503)
                adapter = self.adapters.get(spec['provider'])
                if (not adapter or adapter.configuration != spec['configuration']
                        or spec.get('billing_basis') not in (BILLING_BASIS, 'supplier_usage_tariff')):
                    raise TaskError('QUOTE_CONFIGURATION_CHANGED')
                conn.execute("UPDATE aiml_generation_tasks SET status='reserving',error_code=NULL WHERE quote_id=?", (quote_id,))
                state = 'reserve'
            elif row['status'] == 'settling':
                conn.execute("UPDATE aiml_generation_tasks SET status='settlement-running' WHERE quote_id=?", (quote_id,))
                state = 'settle'
            else:
                return self.public(row)
        if state == 'reserve':
            try:
                reserved = self.settlement('reserve', {'app_name': APP, 'request_id': quote_id,
                    'feature': spec['feature'], 'api_source': 'platform_api', 'budget_cny': spec['display_cny']}, headers)
            except Exception as exc:
                # No supplier call occurred. A timeout might still have created an
                # idempotent reservation; the same quote is safe to retry.
                self.update(quote_id, status='reserve-failed', error_code=getattr(exc, 'code', 'RESERVATION_UNAVAILABLE'))
                raise TaskError(getattr(exc, 'code', 'RESERVATION_UNAVAILABLE'), getattr(exc, 'status', 503)) from None
            task_id = reserved['task_id']
            self.update(quote_id, status='executing', settlement_id=task_id)
            try:
                execution_started = self.clock()
                result, receipt = self.adapters[spec['provider']].execute(spec, account, quote_id)
                receipt, status = self.record_execution(quote_id, spec, result, receipt, execution_started)
                if status != 'settlement-running':
                    return self.status(quote_id, account)
            except NoChargeFailure:
                receipt = {'cost_cny': '0', 'bill_ref': 'no-charge:' + quote_id, 'billed_model': spec['model'], 'action': 'release',
                           'billing_basis': BILLING_BASIS, 'standard_tariff_cny': '0', 'supplier_debit_cny': '0',
                           'settlement_basis': 'no_charge_failure'}
                self.update(quote_id, status='settlement-running', receipt=self.seal(receipt), error_code='SUPPLIER_REJECTED_NO_CHARGE')
            except SupplierTaskFailure as exc:
                self.record_failed_usage(quote_id, exc.evidence)
                return self.status(quote_id, account)
            except Exception as exc:
                adapter = self.adapters[spec['provider']]
                if hasattr(adapter, 'recovery_failed'): adapter.recovery_failed(quote_id, exc)
                self.update(quote_id, status='unknown', error_code=exc.code if isinstance(exc, TaskError) else 'SUPPLIER_OUTCOME_UNKNOWN')
                return self.status(quote_id, account)
        else:
            receipt = self.unseal(row['receipt'])
            task_id = row['settlement_id']
        try:
            settled = self.settlement(receipt['action'], {'app_name': APP, 'task_id': task_id,
                'cost_cny': receipt['cost_cny'], 'provider': spec['provider'], 'bill_ref': receipt['bill_ref'],
                'attempt_id': quote_id, 'billed_model': receipt['billed_model']}, headers)
            if settled.get('status') != ('committed' if receipt['action'] == 'commit' else 'released'):
                raise TaskError('SETTLEMENT_UNVERIFIED', 503)
            self.update(quote_id, status='succeeded' if receipt['action'] == 'commit' and not receipt.get('failure_evidence') else 'failed')
        except Exception:
            self.update(quote_id, status='settling')
        return self.status(quote_id, account)

    def waive_legacy_unknown(self, quote_id):
        """Private operator repair: the platform bears any uncertain cost.

        This is an explicit customer-charge waiver, NOT evidence that the
        supplier charged zero. No public route, no supplier call, no retry.
        Restricted to missing-receipt historical MiniMax attempts predating
        durable provider checkpoints (2026-10-13 11:06 UTC).
        """
        with self.transaction() as conn:
            row = conn.execute('SELECT * FROM aiml_generation_tasks WHERE quote_id=?', (quote_id,)).fetchone()
            if not row: raise TaskError('TASK_NOT_FOUND', 404)
            if row['receipt']:
                receipt = self.unseal(row['receipt'])
                if receipt.get('settlement_basis') == 'platform_waiver_legacy_unknown' and row['status'] in ('settling', 'failed'):
                    return self.public(row)
                raise TaskError('TASK_NOT_WAIVABLE')
            spec = self.unseal(row['spec'])
            adapter = self.adapters.get('minimax')
            if (row['status'] != 'unknown' or row['result'] or not row['settlement_id']
                    or spec['provider'] != 'minimax' or row['created_at'] >= 1791889581
                    or adapter and getattr(adapter, 'checkpoint', lambda _: None)(quote_id)):
                raise TaskError('TASK_NOT_WAIVABLE')
            receipt = {'action': 'release', 'cost_cny': '0', 'bill_ref': 'platform-waiver:' + quote_id,
                       'billed_model': spec['model'], 'billing_basis': spec['billing_basis'],
                       'settlement_basis': 'platform_waiver_legacy_unknown',
                       'supplier_cost_unknown': True, 'original_error_code': row['error_code'],
                       'resolved_at': self.clock()}
            conn.execute('UPDATE aiml_generation_tasks SET status=?,receipt=?,error_code=? WHERE quote_id=?',
                         ('settling', self.seal(receipt), 'PLATFORM_WAIVED_LEGACY_UNKNOWN', quote_id))
            return self.public(self.read(conn, quote_id, row['account_id']))

    def confirm_supplier_bill(self, quote_id, provider, bill_ref, supplier_debit_cny, billed_amount_cny=None, billing_evidence=None):
        """Private reconciliation hook for a verified, task-matched supplier bill.

        Deliberately absent from public HTTP routes. Callers must obtain and
        verify supplier bills server-side; customer-supplied prices are rejected.
        This updates billing only and can never execute the supplier again.
        """
        debit = format(money(supplier_debit_cny), '.8f')
        billed = format(money(billed_amount_cny), '.8f') if billed_amount_cny is not None else None
        if billing_evidence is not None:
            if (not isinstance(billing_evidence, dict) or set(billing_evidence) -
                    {'source', 'resource_id', 'day', 'hour', 'usage_sha256', 'account_usage_sha256', 'bill_sha256', 'bill_detail_ids'}
                    or billing_evidence.get('source') not in ('GetInferenceUsage', 'ListSplitBillDetail', 'ListBillDetail', 'DescribeInstanceBill')
                    or len(canonical(billing_evidence)) > 65536):
                raise TaskError('BILL_EVIDENCE_UNVERIFIED', 503)
        with self.transaction() as conn:
            row = conn.execute('SELECT * FROM aiml_generation_tasks WHERE quote_id=?', (quote_id,)).fetchone()
            if not row or row['status'] not in ('awaiting-bill', 'failed-awaiting-bill', 'bill-review', 'settling', 'settlement-running', 'succeeded', 'failed'):
                raise TaskError('SUPPLIER_BILL_NOT_EXPECTED')
            spec, receipt = self.unseal(row['spec']), self.unseal(row['receipt'])
            failure_bill = receipt.get('settlement_basis') == 'failed_supplier_bill'
            if failure_bill and billing_evidence is None:
                raise TaskError('BILL_EVIDENCE_UNVERIFIED', 503)
            if spec.get('billing_basis') == 'supplier_usage_tariff' and not failure_bill:
                raise TaskError('SUPPLIER_BILL_NOT_EXPECTED')
            if spec['provider'] != provider or receipt['bill_ref'] != bill_ref:
                raise TaskError('SUPPLIER_BILL_TASK_MISMATCH', 403)
            if receipt['supplier_debit_cny'] is not None:
                if money(receipt['supplier_debit_cny']) != money(debit) or receipt.get('billed_amount_cny') != billed:
                    raise TaskError('SUPPLIER_BILL_CONFLICT')
                return self.public(row)
            cost, basis = (debit, 'failed_supplier_bill') if failure_bill else billing_amount(receipt['standard_tariff_cny'], debit, billed)
            receipt.update(supplier_debit_cny=debit, billed_amount_cny=billed, cost_cny=cost, settlement_basis=basis)
            if failure_bill: receipt['action'] = 'commit' if money(debit) > 0 else 'release'
            if billing_evidence is not None:
                receipt['billing_evidence'] = billing_evidence
            status = 'bill-review' if money(cost) > money(spec['display_cny']) else 'settling'
            conn.execute('UPDATE aiml_generation_tasks SET receipt=?,status=?,error_code=? WHERE quote_id=?',
                         (self.seal(receipt), status, 'COST_EXCEEDS_QUOTE' if status == 'bill-review' else None, quote_id))
            return self.public(self.read(conn, quote_id, row['account_id']))

    def adopt_usage_policy(self, quote_id):
        """Private, explicitly authorized migration of existing pending tasks.

        No HTTP route exposes this. Validated supplier receipts are required;
        unknown, completed and unexecuted tasks cannot be repriced. This only
        prepares a normal authenticated, idempotent settlement, never inference.
        """
        with self.transaction() as conn:
            row = conn.execute('SELECT * FROM aiml_generation_tasks WHERE quote_id=?', (quote_id,)).fetchone()
            if not row or row['status'] not in ('awaiting-bill', 'settling') or not row['result'] or not row['receipt']:
                raise TaskError('USAGE_POLICY_MIGRATION_NOT_ALLOWED')
            spec, receipt, result = [self.unseal(row[k]) for k in ('spec', 'receipt', 'result')]
            if spec.get('billing_basis') == 'supplier_usage_tariff':
                return self.public(row)
            if spec['provider'] not in ('volcengine', 'aliyun') or receipt.get('action') != 'commit' or receipt.get('cost_cny') is not None:
                raise TaskError('USAGE_POLICY_MIGRATION_NOT_ALLOWED')
            charged = self.adapters[spec['provider']].confirmed_usage_cost(spec, result, receipt, quote_id)
            if money(charged) > money(spec['display_cny']):
                raise TaskError('COST_EXCEEDS_QUOTE')
            receipt.update(cost_cny=charged, billing_basis='supplier_usage_tariff', settlement_basis='supplier_usage_tariff',
                           policy_migration={'from':spec['billing_basis'], 'authorized_date':'2026-10-14'})
            spec['billing_basis'] = 'supplier_usage_tariff'
            conn.execute("UPDATE aiml_generation_tasks SET spec=?,receipt=?,status='settling',error_code=NULL WHERE quote_id=?",
                         (self.seal(spec), self.seal(receipt), quote_id))
            return self.public(self.read(conn, quote_id, row['account_id']))

    def handle(self, action, data, headers):
        if not isinstance(data, dict) or data.get('app_name') != APP:
            raise TaskError('APP_SCOPE_DENIED', 403)
        account = self.identity(headers)
        if action == 'quote':
            return self.quote(data, account)
        if action == 'run':
            return self.run(data, account, headers)
        if action == 'status' and set(data) == {'app_name', 'quote_id'}:
            current = self.status(data['quote_id'], account)
            if (current['status'] == 'awaiting-bill' or (current['status'] == 'failed' and current.get('billing_pending'))) and self.billing_resolver:
                try:
                    self.billing_resolver(self, data['quote_id'])
                except Exception:
                    # Unavailable/invalid billing keeps the existing reservation.
                    # Never expose supplier errors or reinterpret missing data.
                    pass
                current = self.status(data['quote_id'], account)
            if current['status'] == 'settling':
                return self.run({'app_name': APP, 'quote_id': data['quote_id'], 'confirm_run': True}, account, headers)
            return current
        raise TaskError('INVALID_TASK_REQUEST', 400)
