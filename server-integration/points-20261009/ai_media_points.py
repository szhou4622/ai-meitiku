"""AI media-only precise settlement in the existing central SQLite database."""
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

APP = 'ai-media-library'
SCALE = 1_000_000
COST_RATE = 200
RECHARGE_RATE = 100
MAX_UNITS = 10**15
FEATURES = frozenset(('schemes', 'classifier', 'subtitle-removal', 'voice', 'prompt-library'))
PREFIX = '/api/license/ai-media-library/points/'


class PointsError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


def fail(code, message, status=400):
    raise PointsError(code, message, status)


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(value, field):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', value):
        fail('INVALID_IDENTIFIER', field + '格式无效')
    return value


def amount(value, rate):
    # Money must be decimal text, never a JSON floating-point number.
    if not isinstance(value, str) or not re.fullmatch(r'(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?', value):
        fail('INVALID_COST', '金额必须为非负十进制字符串，最多8位小数')
    try:
        units = Decimal(value) * rate * SCALE
    except InvalidOperation:
        fail('INVALID_COST', '金额无效')
    if units != units.to_integral_value() or units > MAX_UNITS:
        fail('INVALID_COST', '金额精度或上限不符合要求')
    return int(units)


def points_text(units):
    return format(Decimal(units) / SCALE, '.6f')


def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def code_hash(code):
    if not isinstance(code, str) or not re.fullmatch(r'(?:AIML-P-[A-Z0-9]{24,64}|AIM-(?:[A-Z0-9]{4}-){2}[A-Z0-9]{4})', code):
        fail('INVALID_REDEEM_CODE', '积分码格式无效')
    return hashlib.sha256((APP + ':' + code).encode()).hexdigest()


def create_schema(conn):
    # All new tables are app-specific. No ALTER/UPDATE of shared product tables.
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS aiml_point_wallets (
      app_name TEXT NOT NULL CHECK(app_name='ai-media-library'),
      account_id TEXT NOT NULL, balance_units INTEGER NOT NULL CHECK(balance_units>=0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(app_name,account_id));
    CREATE TABLE IF NOT EXISTS aiml_point_codes (
      app_name TEXT NOT NULL CHECK(app_name='ai-media-library'),
      code_hash TEXT NOT NULL, issue_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      grant_units INTEGER NOT NULL CHECK(grant_units>0),
      redeemed_account TEXT, redeemed_request TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(app_name,code_hash), UNIQUE(app_name,issue_id));
    CREATE TABLE IF NOT EXISTS aiml_point_tasks (
      app_name TEXT NOT NULL CHECK(app_name='ai-media-library'),
      task_id TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL,
      feature TEXT NOT NULL, fingerprint TEXT NOT NULL,
      reserved_units INTEGER NOT NULL CHECK(reserved_units>0),
      charged_units INTEGER NOT NULL DEFAULT 0 CHECK(charged_units>=0),
      status TEXT NOT NULL CHECK(status IN ('reserved','committed','released')),
      settlement_fingerprint TEXT, cost_cny TEXT, provider TEXT, bill_ref TEXT,
      attempt_id TEXT, billed_model TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(app_name,task_id), UNIQUE(app_name,account_id,request_id),
      UNIQUE(app_name,provider,bill_ref));
    CREATE TABLE IF NOT EXISTS aiml_point_ledger (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL CHECK(app_name='ai-media-library'),
      account_id TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL,
      delta_units INTEGER NOT NULL, balance_units INTEGER NOT NULL,
      task_id TEXT, created_at TEXT NOT NULL,
      UNIQUE(app_name,account_id,event_id));
    CREATE TABLE IF NOT EXISTS aiml_point_redemptions (
      app_name TEXT NOT NULL CHECK(app_name='ai-media-library'),
      account_id TEXT NOT NULL, request_id TEXT NOT NULL, code_hash TEXT NOT NULL,
      PRIMARY KEY(app_name,account_id,request_id));
    CREATE INDEX IF NOT EXISTS aiml_task_account_status
      ON aiml_point_tasks(app_name,account_id,status);
    CREATE INDEX IF NOT EXISTS aiml_ledger_account_sequence
      ON aiml_point_ledger(app_name,account_id,sequence);
    """)


class Settlement:
    def __init__(self, db_path, authenticate, internal_token='', consumption_enabled=False):
        self.db_path = str(db_path)
        self.authenticate = authenticate
        self.internal_token = internal_token
        self.consumption_enabled = consumption_enabled

    def initialize(self):
        with sqlite3.connect(self.db_path, timeout=15) as conn:
            create_schema(conn)

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

    def scope(self, data):
        if not isinstance(data, dict) or data.get('app_name') != APP:
            fail('APP_SCOPE_MISMATCH', '请求必须明确指定 ai-media-library', 403)

    def internal(self, headers):
        supplied = str(headers.get('X-AIML-Settlement-Token') or '')
        if not self.internal_token or not hmac.compare_digest(supplied, self.internal_token):
            fail('INTERNAL_AUTH_REQUIRED', '此操作仅允许媒体库服务器调用', 403)

    def identity(self, headers, expired=False):
        row = self.authenticate(headers, allow_expired=expired)
        if row.get('app_name') != APP:
            fail('APP_CREDENTIAL_MISMATCH', '凭证不属于媒体库', 403)
        identifier(row.get('code_id'), '账户标识')
        return row

    def recheck(self, conn, row):
        # Re-read inside the write transaction to close the auth/unbind race.
        current = conn.execute('SELECT * FROM activations WHERE app_name=? AND code_id=?',
                               (APP, row['code_id'])).fetchone()
        if current is None:
            fail('DEVICE_CHANGED', '设备授权已变更', 401)
        for field in ('bound_machine_code', 'credential_version', 'device_credential_hash',
                      'binding_status', 'binding_role', 'code_hash'):
            if current[field] != row.get(field):
                fail('DEVICE_CHANGED', '设备授权已变更', 401)
        code = conn.execute('SELECT disabled FROM redeem_codes WHERE app_name=? AND code_id=?',
                            (APP, row['code_id'])).fetchone()
        if code and code[0]:
            fail('LICENSE_DISABLED', '授权已停用', 401)

    def wallet(self, conn, account):
        row = conn.execute('SELECT * FROM aiml_point_wallets WHERE app_name=? AND account_id=?',
                           (APP, account)).fetchone()
        if row is None:
            # Never invent grants from time/VIP entitlement or copy legacy balances.
            legacy = conn.execute('SELECT COALESCE(SUM(balance),0) FROM point_accounts WHERE app_name=? AND code_id=?',
                                  (APP, account)).fetchone()[0]
            if legacy:
                fail('LEGACY_BALANCE_REVIEW_REQUIRED', '历史积分余额需核对后迁移', 409)
            stamp = now()
            conn.execute('INSERT INTO aiml_point_wallets VALUES (?,?,0,?,?)', (APP, account, stamp, stamp))
            row = conn.execute('SELECT * FROM aiml_point_wallets WHERE app_name=? AND account_id=?',
                               (APP, account)).fetchone()
        return row

    def balance(self, conn, account):
        wallet = self.wallet(conn, account)
        reserved = conn.execute("SELECT COALESCE(SUM(reserved_units),0) FROM aiml_point_tasks WHERE app_name=? AND account_id=? AND status='reserved'",
                                (APP, account)).fetchone()[0]
        balance = wallet['balance_units']
        return {'balance_units': balance, 'reserved_units': reserved, 'available_units': balance - reserved,
                'balance': points_text(balance), 'reserved': points_text(reserved),
                'available': points_text(balance - reserved), 'unit_scale': SCALE}

    def change(self, conn, account, delta, event_id, kind, task_id=None):
        balance = self.wallet(conn, account)['balance_units'] + delta
        if balance < 0 or balance > MAX_UNITS:
            fail('BALANCE_LIMIT', '积分余额不足或超出上限', 402)
        stamp = now()
        conn.execute('UPDATE aiml_point_wallets SET balance_units=?,updated_at=? WHERE app_name=? AND account_id=?',
                     (balance, stamp, APP, account))
        conn.execute('INSERT INTO aiml_point_ledger(app_name,account_id,event_id,kind,delta_units,balance_units,task_id,created_at) VALUES (?,?,?,?,?,?,?,?)',
                     (APP, account, event_id, kind, delta, balance, task_id, stamp))

    def task_result(self, conn, task, replay=False):
        return {'task_id': task['task_id'], 'status': task['status'], 'feature': task['feature'],
                'charged_units': task['charged_units'], 'points_used': points_text(task['charged_units']),
                'idempotent': replay, **self.balance(conn, task['account_id'])}

    def import_legacy_card(self, conn, code, hashed):
        """Consume an unused media-only legacy points card in the same DB transaction.

        Existing activation/time cards and legacy account balances are never migrated here.
        The stored credits are already points, not a currency amount.
        """
        if not re.fullmatch(r'AIM-(?:[A-Z0-9]{4}-){2}[A-Z0-9]{4}', code):
            fail('REDEEM_CODE_NOT_FOUND', '积分码无效', 404)
        rows = conn.execute('SELECT code_id,credits,unlimited,disabled,duration_days,license_type,expires_at '
                            'FROM redeem_codes WHERE app_name=? AND code_plaintext=? LIMIT 2',
                            (APP, code)).fetchall()
        if not rows:
            fail('REDEEM_CODE_NOT_FOUND', '积分码无效', 404)
        if len(rows) != 1:
            fail('LEGACY_CODE_REVIEW_REQUIRED', '旧格式积分码需管理员核对', 409)
        old = rows[0]
        if old['disabled']:
            fail('REDEEM_CODE_USED', '积分码已使用或停用', 409)
        if (old['unlimited'] or old['duration_days'] != 0
                or old['license_type'] not in ('standard', 'points', 'credits')
                or old['expires_at'] or type(old['credits']) is not int or old['credits'] <= 0
                or old['credits'] * SCALE > MAX_UNITS):
            fail('LEGACY_CODE_REVIEW_REQUIRED', '该旧码不是可直接兑换的积分充值码', 409)
        for table in ('activations', 'point_accounts'):
            if conn.execute('SELECT 1 FROM ' + table + ' WHERE app_name=? AND code_id=? LIMIT 1',
                            (APP, old['code_id'])).fetchone():
                fail('REDEEM_CODE_USED', '该旧码已有授权或账户记录，不能再次充值', 409)
        units = old['credits'] * SCALE
        issue_id = 'legacy:' + old['code_id']
        fingerprint = digest({'code_hash': hashed, 'units': units, 'source': 'legacy-media-card'})
        conn.execute('INSERT INTO aiml_point_codes VALUES (?,?,?,?,?,NULL,NULL,?)',
                     (APP, hashed, issue_id, fingerprint, units, now()))
        changed = conn.execute('UPDATE redeem_codes SET disabled=1 WHERE app_name=? AND code_id=? AND disabled=0',
                               (APP, old['code_id'])).rowcount
        if changed != 1:
            fail('LEGACY_CODE_REVIEW_REQUIRED', '旧积分码状态已变更', 409)
        return conn.execute('SELECT * FROM aiml_point_codes WHERE app_name=? AND code_hash=?',
                            (APP, hashed)).fetchone()

    def handle(self, action, data, headers):
        self.scope(data)
        public_fields = {
            'balance': {'app_name'},
            'transactions': {'app_name', 'before_sequence', 'limit'},
            'redeem': {'app_name', 'request_id', 'code'},
        }
        if action in public_fields:
            if set(data) - public_fields[action]:
                fail('UNEXPECTED_FIELDS', '请求含有不允许的字段')
            identity = self.identity(headers, expired=True)
            with self.transaction() as conn:
                self.recheck(conn, identity)
                account = identity['code_id']
                result = self.balance(conn, account)
                if action == 'transactions':
                    before, limit = data.get('before_sequence', 2**63-1), data.get('limit', 50)
                    if type(before) is not int or not 0 < before <= 2**63-1 or type(limit) is not int or not 1 <= limit <= 100:
                        fail('INVALID_PAGINATION', '分页参数无效')
                    rows = conn.execute('SELECT sequence,kind,delta_units,balance_units,task_id,created_at FROM aiml_point_ledger WHERE app_name=? AND account_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?',
                                        (APP, account, before, limit)).fetchall()
                    result['items'] = [dict(r) for r in rows]
                    result['next_before_sequence'] = rows[-1]['sequence'] if rows else None
                if action == 'redeem':
                    request_id = identifier(data.get('request_id'), '请求编号')
                    hashed = code_hash(data.get('code'))
                    replay = conn.execute('SELECT code_hash FROM aiml_point_redemptions WHERE app_name=? AND account_id=? AND request_id=?',
                                          (APP, account, request_id)).fetchone()
                    if replay:
                        if replay['code_hash'] != hashed:
                            fail('IDEMPOTENCY_CONFLICT', '请求编号已用于其他积分码', 409)
                        return {'ok': True, 'app_name': APP, 'idempotent': True, **result}
                    card = conn.execute('SELECT * FROM aiml_point_codes WHERE app_name=? AND code_hash=?', (APP, hashed)).fetchone()
                    if card is None:
                        card = self.import_legacy_card(conn, data['code'], hashed)
                    if card['redeemed_account'] and card['redeemed_account'] != account:
                        fail('REDEEM_CODE_USED', '积分码已被兑换', 409)
                    replay = bool(card['redeemed_account'])
                    if not replay:
                        self.change(conn, account, card['grant_units'], 'redeem:' + hashed, 'recharge')
                        conn.execute('UPDATE aiml_point_codes SET redeemed_account=?,redeemed_request=? WHERE app_name=? AND code_hash=?',
                                     (account, request_id, APP, hashed))
                    conn.execute('INSERT INTO aiml_point_redemptions VALUES (?,?,?,?)', (APP, account, request_id, hashed))
                    result = {'idempotent': replay, **self.balance(conn, account)}
                return {'ok': True, 'app_name': APP, **result}
        self.internal(headers)
        if action == 'issue-code':
            # Legacy AIM codes must originate from their existing authoritative record.
            if not isinstance(data.get('code'), str) or not re.fullmatch(r'AIML-P-[A-Z0-9]{24,64}', data['code']):
                fail('INVALID_REDEEM_CODE', '新积分码格式无效')
            hashed = code_hash(data.get('code'))
            issue_id = identifier(data.get('request_id'), '发码编号')
            units = amount(data.get('paid_cny'), RECHARGE_RATE)
            if units <= 0:
                fail('INVALID_GRANT', '充值金额必须大于0')
            fp = digest({'code_hash': hashed, 'units': units})
            with self.transaction() as conn:
                old = conn.execute('SELECT * FROM aiml_point_codes WHERE app_name=? AND issue_id=?', (APP, issue_id)).fetchone()
                if old and old['fingerprint'] != fp:
                    fail('IDEMPOTENCY_CONFLICT', '发码编号参数冲突', 409)
                if not old:
                    try:
                        conn.execute('INSERT INTO aiml_point_codes VALUES (?,?,?,?,?,NULL,NULL,?)', (APP, hashed, issue_id, fp, units, now()))
                    except sqlite3.IntegrityError:
                        fail('CODE_ALREADY_ISSUED', '积分码已存在', 409)
                return {'ok': True, 'app_name': APP, 'grant_units': units, 'points': points_text(units), 'idempotent': bool(old)}
        if action == 'reserve':
            if not self.consumption_enabled:
                fail('CONSUMPTION_DISABLED', '平台积分消费尚未开放', 503)
            if data.get('api_source') != 'platform_api':
                fail('CUSTOMER_API_NOT_BILLABLE', '用户自接API不扣软件积分', 409)
            if data.get('feature') not in FEATURES:
                fail('FEATURE_NOT_BILLABLE', '该功能不属于积分计费范围', 403)
            identity = self.identity(headers)
            request_id = identifier(data.get('request_id'), '任务请求编号')
            units = amount(data.get('budget_cny'), COST_RATE)
            if units <= 0:
                fail('INVALID_BUDGET', '任务预算必须大于0')
            fp = digest({'feature': data['feature'], 'budget_units': units, 'api_source': 'platform_api'})
            with self.transaction() as conn:
                self.recheck(conn, identity)
                account = identity['code_id']
                old = conn.execute('SELECT * FROM aiml_point_tasks WHERE app_name=? AND account_id=? AND request_id=?', (APP, account, request_id)).fetchone()
                if old:
                    if old['fingerprint'] != fp:
                        fail('IDEMPOTENCY_CONFLICT', '任务编号参数冲突', 409)
                    return {'ok': True, 'app_name': APP, **self.task_result(conn, old, True)}
                if self.balance(conn, account)['available_units'] < units:
                    fail('INSUFFICIENT_POINTS', '可用积分不足', 402)
                task_id, stamp = secrets.token_hex(20), now()
                conn.execute("INSERT INTO aiml_point_tasks(app_name,task_id,account_id,request_id,feature,fingerprint,reserved_units,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'reserved',?,?)",
                             (APP, task_id, account, request_id, data['feature'], fp, units, stamp, stamp))
                self.change(conn, account, 0, 'reserve:' + task_id, 'reserve', task_id)
                task = conn.execute('SELECT * FROM aiml_point_tasks WHERE app_name=? AND task_id=?', (APP, task_id)).fetchone()
                return {'ok': True, 'app_name': APP, **self.task_result(conn, task)}
        if action not in ('commit', 'release'):
            fail('UNKNOWN_ENDPOINT', '未知媒体库积分接口', 404)
        task_id = identifier(data.get('task_id'), '任务编号')
        provider = data.get('provider')
        if provider not in ('volcengine', 'aliyun', 'minimax', 'relay'):
            fail('INVALID_PROVIDER', '供应商标识无效')
        bill_ref = identifier(data.get('bill_ref'), '费用凭据编号')
        attempt_id = identifier(data.get('attempt_id'), '调用尝试编号')
        billed_model = identifier(data.get('billed_model'), '计费模型')
        units = amount(data.get('cost_cny'), COST_RATE)
        if action == 'release' and units:
            fail('COST_NOT_ZERO', '存在供应商费用的任务必须结算，不能全额释放', 409)
        fp = digest({'action': action, 'provider': provider, 'bill_ref': bill_ref, 'units': units, 'attempt_id': attempt_id, 'billed_model': billed_model})
        with self.transaction() as conn:
            task = conn.execute('SELECT * FROM aiml_point_tasks WHERE app_name=? AND task_id=?', (APP, task_id)).fetchone()
            if task is None:
                fail('TASK_NOT_FOUND', '任务不存在', 404)
            if task['status'] != 'reserved':
                if task['settlement_fingerprint'] != fp:
                    fail('SETTLEMENT_CONFLICT', '任务已完成另一笔结算', 409)
                return {'ok': True, 'app_name': APP, **self.task_result(conn, task, True)}
            if units > task['reserved_units']:
                fail('COST_EXCEEDS_BUDGET', '实际费用超出授权预算，冻结金额保留待核对', 409)
            try:
                conn.execute('UPDATE aiml_point_tasks SET status=?,charged_units=?,settlement_fingerprint=?,cost_cny=?,provider=?,bill_ref=?,attempt_id=?,billed_model=?,updated_at=? WHERE app_name=? AND task_id=?',
                             ('committed' if action == 'commit' else 'released', units, fp, data['cost_cny'], provider, bill_ref, attempt_id, billed_model, now(), APP, task_id))
            except sqlite3.IntegrityError:
                fail('BILL_REFERENCE_USED', '费用凭据已用于其他任务', 409)
            self.change(conn, task['account_id'], -units, action + ':' + task_id, action, task_id)
            task = conn.execute('SELECT * FROM aiml_point_tasks WHERE app_name=? AND task_id=?', (APP, task_id)).fetchone()
            return {'ok': True, 'app_name': APP, **self.task_result(conn, task)}
