"""Read-only permission and Seed Lite metering check. Never prints credentials."""
import argparse
import datetime as dt
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'server-integration/platform-20261009'))
from volcengine_billing import VolcengineBilling
from volcengine_reconcile import usage_records, MODEL_NAME, MODEL_VERSION

parser = argparse.ArgumentParser()
parser.add_argument('--resource-id')
args = parser.parse_args()
text = pathlib.Path('/Users/a1-6/Downloads/AccessKey.txt').read_text()
ak = re.search(r'(?:Access\s*Key\s*ID|AccessKeyID|AccessKeyId|access_key_id|AK)\s*[:：=]\s*["\']?([^\s"\',;]+)', text, re.I).group(1)
sk = re.search(r'(?:Secret\s*Access\s*Key|Access\s*Key\s*Secret|AccessKeySecret|SecretAccessKey|secret_access_key|SK)\s*[:：=]\s*["\']?([^\s"\',;]+)', text, re.I).group(1)
day = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime('%Y-%m-%d')
try:
    result = VolcengineBilling(ak, sk).query('GetInferenceUsage', {'QueryInterval': 'Hour',
        'StartTime': day, 'EndTime': day, 'Filters': [{'Key': 'ApikeyID', 'Values': [args.resource_id] if args.resource_id else []},
        {'Key': 'ModelName', 'Values': [MODEL_NAME]}, {'Key': 'ModelVersion', 'Values': [MODEL_VERSION]},
        {'Key': 'BillingStatus', 'Values': []}], 'ShowWindowDetail': True})
    fields = ['ApikeyID', 'ModelName', 'ModelVersion', 'Day', 'Hour', 'BillingStatus',
              'InputTokens', 'CacheTokensHit', 'OutputTokens', 'TotalTokens', 'ReqCnt']
    print(json.dumps({'ok': True, 'permission_verified': True, 'supplier_requests': 0,
        'records': [{k: row.get(k) for k in fields} for row in usage_records(result)]}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({'ok': False, 'code': getattr(error, 'code', 'BILL_READ_CHECK_FAILED'), 'supplier_requests': 0}))
    raise SystemExit(1)
