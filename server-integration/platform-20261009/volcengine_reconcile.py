"""Private reconciliation of one API Key's usage and model split bills.

Unmatched/partial supplier data stays pending. A zero balance or empty response
is never evidence of a free request. No supplier inference is performed here.
"""
import datetime as dt
import re
import threading
import time
from decimal import Decimal, ROUND_DOWN
from ai_media_tasks import TaskError, money, fingerprint
from volcengine_platform import MODEL

BEIJING = dt.timezone(dt.timedelta(hours=8))
FREE = frozenset({'no_need_billing', 'free_for_free_quota', 'free_for_limit_boundary',
                  'free_for_model_unit', 'free_for_viptier'})
MODEL_NAME, MODEL_VERSION = MODEL.rsplit('-', 1)


def usage_records(result):
    names = [item['Name'] for item in result['Fields']]
    if len(names) != len(set(names)) or len(result['Data']) != result['DataCount']:
        raise TaskError('BILL_USAGE_UNVERIFIED', 503)
    if any(len(row) != len(names) for row in result['Data']):
        raise TaskError('BILL_USAGE_UNVERIFIED', 503)
    return [dict(zip(names, row)) for row in result['Data']]


def count(value):
    if not isinstance(value, (int, str)) or isinstance(value, bool) or not re.fullmatch(r'\d+', str(value)):
        raise TaskError('BILL_USAGE_UNVERIFIED', 503)
    return int(value)


def usage_matches(rows, resource_id, day, hour, expected):
    if not rows:
        return False
    for row in rows:
        if (row.get('ApikeyID') != resource_id or row.get('ModelName') != MODEL_NAME
                or row.get('ModelVersion') != MODEL_VERSION or row.get('Day') != day
                or count(row.get('Hour')) != hour or row.get('BillingStatus') not in FREE | {'normal'}):
            return False
    totals = {field: sum(count(row.get(field)) for row in rows) for field in expected}
    return totals == expected


def allocate(amount, weighted):
    """Deterministic 8-decimal allocation, preserving the supplier bill total."""
    total = sum(weight for _, weight in weighted)
    if total <= 0:
        raise TaskError('BILL_ALLOCATION_UNVERIFIED', 503)
    units = int(money(amount) * 100000000)
    raw = [(qid, Decimal(units) * weight / total) for qid, weight in weighted]
    shares = {qid: int(value.to_integral_value(rounding=ROUND_DOWN)) for qid, value in raw}
    remainder = units - sum(shares.values())
    for qid, _ in sorted(raw, key=lambda item: (-(item[1] - shares[item[0]]), item[0]))[:remainder]:
        shares[qid] += 1
    return {qid: format(Decimal(value) / 100000000, '.8f') for qid, value in shares.items()}


class VolcengineReconciler:
    def __init__(self, billing, resource_id, configuration, clock=time.time):
        if not isinstance(resource_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', resource_id):
            raise ValueError('missing API Key resource ID')
        self.billing, self.resource_id, self.configuration = billing, resource_id, configuration
        self.clock, self.lock, self.attempts = clock, threading.Lock(), {}

    def __call__(self, tasks, quote_id):
        # One query per bucket per minute, including parallel clients.
        with self.lock:
            return self.reconcile(tasks, quote_id)

    def reconcile(self, tasks, quote_id):
        with tasks.transaction() as conn:
            all_rows = conn.execute('SELECT * FROM aiml_generation_tasks').fetchall()
        selected = next((row for row in all_rows if row['quote_id'] == quote_id), None)
        if not selected or selected['status'] != 'awaiting-bill' or tasks.unseal(selected['spec'])['provider'] != 'volcengine':
            return
        selected_receipt = tasks.unseal(selected['receipt'])
        moment = dt.datetime.fromtimestamp(selected_receipt['execution_started'], BEIJING)
        day, hour = moment.strftime('%Y-%m-%d'), moment.hour
        bucket = day + ':' + str(hour)
        if self.clock() - self.attempts.get(bucket, 0) < 60:
            return
        self.attempts[bucket] = self.clock()
        group = []
        for row in all_rows:
            spec = tasks.unseal(row['spec'])
            if spec['provider'] != 'volcengine' or spec['configuration'] != self.configuration:
                continue
            if row['status'] in ('unknown', 'executing'):
                # A missing usage receipt could otherwise hide another call.
                return
            if not row['result'] or not row['receipt']:
                continue
            receipt = tasks.unseal(row['receipt'])
            if receipt.get('action') != 'commit':
                continue
            start = dt.datetime.fromtimestamp(receipt['execution_started'], BEIJING)
            finish = dt.datetime.fromtimestamp(receipt['execution_finished'], BEIJING)
            if start.strftime('%Y-%m-%d') == day and start.hour == hour:
                if finish.strftime('%Y-%m-%d') != day or finish.hour != hour:
                    return
                group.append((row, receipt, tasks.unseal(row['result'])))
        if not group:
            return
        expected = {'ReqCnt': len(group), 'InputTokens': sum(result['usage']['prompt_tokens'] for _, _, result in group),
                    'OutputTokens': sum(result['usage']['completion_tokens'] for _, _, result in group),
                    'CacheTokensHit': sum(result['usage']['prompt_tokens_details']['cached_tokens'] for _, _, result in group),
                    'TotalTokens': sum(result['usage']['total_tokens'] for _, _, result in group)}
        payload = {'QueryInterval': 'Hour', 'StartTime': day, 'EndTime': day,
                   'Filters': [{'Key': 'ApikeyID', 'Values': [self.resource_id]},
                               {'Key': 'ModelName', 'Values': [MODEL_NAME]},
                               {'Key': 'ModelVersion', 'Values': [MODEL_VERSION]},
                               {'Key': 'BillingStatus', 'Values': []}], 'ShowWindowDetail': True}
        records = usage_records(self.billing.query('GetInferenceUsage', payload))
        records = [row for row in records if count(row.get('Hour')) == hour]
        if not usage_matches(records, self.resource_id, day, hour, expected):
            return
        evidence = {'source': 'GetInferenceUsage', 'resource_id': self.resource_id, 'day': day,
                    'hour': hour, 'usage_sha256': fingerprint(records)}
        if all(row['BillingStatus'] in FREE for row in records):
            for row, receipt, _ in group:
                if row['status'] == 'awaiting-bill':
                    tasks.confirm_supplier_bill(row['quote_id'], 'volcengine', receipt['bill_ref'], '0', billing_evidence=evidence)
            return
        if any(row['BillingStatus'] != 'normal' for row in records):
            return  # Mixed allowances require a more detailed split bill.
        bills = []
        source = 'ListSplitBillDetail'
        for offset in range(0, 30000, 300):
            try:
                response = self.billing.query(source, {'BillPeriod': day[:7], 'ExpenseDate': day,
                    'Product': ['ark_bd'], 'SplitDimension': '{"ark_bd":"apikey_id"}', 'SplitItemID': self.resource_id,
                    'GroupPeriod': 2, 'Limit': 300, 'Offset': offset, 'IgnoreZero': 0, 'NeedRecordNum': 1})
            except TaskError:
                if offset:
                    return  # Partial pages are not a complete bill.
                break
            if response.get('Warning') or not isinstance(response.get('List'), list):
                return
            bills.extend(response['List'])
            if len(bills) == response.get('Total'):
                break
            if not response['List']:
                return
        else:
            return
        if not bills:
            # Split bills can lag two days or be disabled. Detailed account bills
            # are usable ONLY when the entire model/version/hour meter matches
            # this key and the app's durable receipts exactly. Foreign keys,
            # other versions, unknown calls and missing rows fail closed.
            account_payload = {**payload, 'Filters': [{'Key': 'ApikeyID', 'Values': []},
                {'Key': 'ModelName', 'Values': [MODEL_NAME]}, {'Key': 'ModelVersion', 'Values': []},
                {'Key': 'BillingStatus', 'Values': []}]}
            account_records = usage_records(self.billing.query('GetInferenceUsage', account_payload))
            account_records = [row for row in account_records if count(row.get('Hour')) == hour]
            if not usage_matches(account_records, self.resource_id, day, hour, expected):
                return
            owners = {str(row.get('AccountID', '')) for row in records + account_records}
            if len(owners) != 1 or not re.fullmatch(r'\d{1,20}', next(iter(owners))):
                return
            owner = next(iter(owners))
            source = 'ListBillDetail'
            evidence['account_usage_sha256'] = fingerprint(account_records)
            for offset in range(0, 30000, 300):
                response = self.billing.query(source, {'BillPeriod': day[:7], 'ExpenseDate': day,
                    'Product': ['ark_bd'], 'OwnerID': [int(owner)], 'GroupTerm': 0, 'GroupPeriod': 2,
                    'Limit': 300, 'Offset': offset, 'IgnoreZero': 0, 'NeedRecordNum': 1})
                if response.get('Warning') or not isinstance(response.get('List'), list):
                    return
                bills.extend(response['List'])
                if len(bills) == response.get('Total'):
                    break
                if not response['List']:
                    return
            else:
                return
        matched = []
        tokens = {'input': Decimal(0), 'output': Decimal(0), 'cache': Decimal(0)}
        pre_allowance = Decimal(0)
        identifier = 'SplitBillDetailId' if source == 'ListSplitBillDetail' else 'BillDetailId'
        for bill in bills:
            if (bill.get('Product') != 'ark_bd' or
                    (source == 'ListSplitBillDetail' and bill.get('SplitItemID') != self.resource_id) or
                    (source == 'ListBillDetail' and str(bill.get('OwnerID')) != owner)):
                return  # Never trust a silently ignored filter.
            if bill.get('ConfigurationCode') != 'Doubao_Seed_2.1_lite':
                continue
            times = re.findall(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', bill.get('ExpenseTime', '')
                if source == 'ListSplitBillDetail' else str(bill.get('ExpenseBeginTime')) + '~' + str(bill.get('ExpenseEndTime')))
            if len(times) != 2:
                return
            begin, end = [dt.datetime.strptime(t, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BEIJING) for t in times]
            if begin.strftime('%Y-%m-%d') != day or begin.hour != hour:
                continue
            if end.timestamp() > self.clock() or end > moment.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=1):
                return
            code = bill.get('ChargeItemCode', '')
            kind = 'cache' if '_KVcache_hit_' in code else 'input' if '_infer_input_' in code else 'output' if '_infer_output_' in code else None
            if (not kind or bill.get('Currency') != 'CNY' or bill.get('Unit') != '千tokens' or not bill.get(identifier)):
                return
            amount = money(bill['SplitItemAmount'] if source == 'ListSplitBillDetail' else bill['Count'])
            deduction = money(bill['DeductionCount'])
            if deduction > amount:
                return
            if deduction:
                rates = {'input': Decimal('0.0008'), 'cache': Decimal('0.00016'), 'output': Decimal('0.0027')}
                if (bill.get('BillingFunction') != '固定单价' or bill.get('DiscountBizBillingFunction') != '-'
                        or bill.get('PriceUnit') != '千tokens' or money(bill.get('Price')) != rates[kind]):
                    return  # Contract/stepped discounts need a dedicated bill rule.
                pre_allowance += amount * rates[kind]
            else:
                pre_allowance += money(bill['DiscountBillAmount'])
            tokens[kind] += amount * 1000
            matched.append(bill)
        if (not matched or tokens != {'input': Decimal(expected['InputTokens'] - expected['CacheTokensHit']),
                                     'output': Decimal(expected['OutputTokens']), 'cache': Decimal(expected['CacheTokensHit'])}):
            return
        if len({row[identifier] for row in matched}) != len(matched):
            return
        debit = format(sum(money(row['PayableAmount']) for row in matched), '.8f')
        billed = format(pre_allowance, '.8f')
        weights = [(row['quote_id'], money(receipt['standard_tariff_cny'])) for row, receipt, _ in group]
        debits, billed_amounts = allocate(debit, weights), allocate(billed, weights)
        evidence.update(source=source, bill_sha256=fingerprint(matched),
                        bill_detail_ids=[bill[identifier] for bill in matched])
        for row, receipt, _ in group:
            if row['status'] == 'awaiting-bill':
                tasks.confirm_supplier_bill(row['quote_id'], 'volcengine', receipt['bill_ref'],
                                            debits[row['quote_id']], billed_amounts[row['quote_id']], billing_evidence=evidence)
