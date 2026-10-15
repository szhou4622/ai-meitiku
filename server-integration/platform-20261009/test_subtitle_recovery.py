import io
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from subtitle_results import SubtitleResults
from subtitle_recovery import retrieve, recover_failure, retryable, public_progress, SubtitleRecoveryWorker
from ai_media_tasks import TaskError


class Storage:
    def __init__(self): self.data = {}; self.fail = False
    def upload_file(self, file, key):
        if self.fail: raise TimeoutError('synthetic interruption')
        self.data[key] = file.read_bytes()
    def head(self, key): return {'size': len(self.data[key])}
    def sign(self, method, key, expires): return ('https://bucket.aliyuncs.com/result', {})


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None, interrupt=False):
        super().__init__(body); self.status = status
        self.headers = headers or {'Content-Length': str(len(body))}
        self.interrupt = interrupt
    def read(self, size=-1):
        if self.interrupt and self.tell(): raise TimeoutError('synthetic disconnection')
        return super().read(3 if self.interrupt else size)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.q = 'a' * 40; self.storage = Storage(); self.state = {'job_id': 'existing-job'}
        self.adapter = SimpleNamespace(state_dir=Path(self.tmp.name), probe=lambda p: 5)
        self.adapter.results = SubtitleResults(Path(self.tmp.name)/'results', b'k'*32, self.storage)
        def checkpoint(q, value=None):
            if value is not None: self.state = dict(value)
            return dict(self.state)
        self.adapter.checkpoint = checkpoint
        self.url = 'https://bucket.aliyuncs.com/file?Expires=' + str(int(time.time())+1800)

    def test_interrupted_retrieval_retains_bytes_and_uses_range_after_restart(self):
        with self.assertRaises(TimeoutError):
            retrieve(self.adapter,self.q,self.url,SimpleNamespace(open=lambda *a,**k:Response(b'abcdef',interrupt=True)))
        self.assertEqual((Path(self.tmp.name)/'downloads'/(self.q+'.part')).read_bytes(),b'abc')
        calls=[]
        def open_response(req,**kw):
            calls.append(req.get_header('Range'))
            return Response(b'def',206,{'Content-Range':'bytes 3-5/6'})
        result, seconds=retrieve(self.adapter,self.q,self.url,SimpleNamespace(open=open_response))
        self.assertEqual(calls,['bytes=3-']);self.assertEqual(result['size_bytes'],6)
        self.assertEqual(next(iter(self.storage.data.values())),b'abcdef');self.assertEqual(seconds,5)
        self.assertNotIn('source_url',public_progress(self.adapter,self.q));self.assertEqual(self.state['phase'],'ready')

    def test_completed_bytes_survive_probe_failure_and_expired_source(self):
        self.adapter.probe=lambda p: (_ for _ in ()).throw(RuntimeError('temporary probe failure'))
        with self.assertRaises(RuntimeError):retrieve(self.adapter,self.q,self.url,SimpleNamespace(open=lambda *a,**k:Response(b'complete')))
        self.adapter.probe=lambda p:5
        result,_=retrieve(self.adapter,self.q,'https://bucket.aliyuncs.com/file?Expires=1',SimpleNamespace(open=lambda *a,**k:self.fail('must reuse durable bytes')))
        self.assertEqual(result['size_bytes'],8)

    def test_expired_source_is_terminal_and_not_retried_or_regenerated(self):
        with self.assertRaises(TaskError) as caught:retrieve(self.adapter,self.q,'https://bucket.aliyuncs.com/file?Expires=1')
        self.assertEqual(caught.exception.code,'SUBTITLE_SOURCE_EXPIRED')
        recover_failure(self.adapter,self.q,caught.exception)
        self.assertFalse(retryable(self.adapter,self.q));self.assertEqual(self.state['phase'],'source-expired')

    def test_transient_failure_records_retry_deadline_without_raw_exception_or_url(self):
        recover_failure(self.adapter,self.q,TimeoutError('https://secret/?Signature=private'))
        self.assertFalse(retryable(self.adapter,self.q));self.assertEqual(self.state['attempts'],1)
        self.assertNotIn('Signature',str(public_progress(self.adapter,self.q)))
        self.state['retry_at']=0;self.assertTrue(retryable(self.adapter,self.q))

    def test_incorrect_partial_range_does_not_corrupt_retained_bytes(self):
        d=Path(self.tmp.name)/'downloads';d.mkdir();(d/(self.q+'.part')).write_bytes(b'abc')
        with self.assertRaises(TaskError):retrieve(self.adapter,self.q,self.url,SimpleNamespace(open=lambda *a,**k:Response(b'wrong',206,{'Content-Range':'bytes 0-4/8'})))
        self.assertEqual((d/(self.q+'.part')).read_bytes(),b'abc')

    def test_worker_continues_without_client_and_limits_scope(self):
        import sqlite3,json
        file=Path(self.tmp.name)/'tasks.sqlite'
        with sqlite3.connect(file) as db:
            db.execute('CREATE TABLE aiml_generation_tasks(quote_id,account_id,spec,status,created_at)')
            for feature,provider in [('subtitle-removal','aliyun'),('voice','minimax')]:
                db.execute('INSERT INTO aiml_generation_tasks VALUES(?,?,?,?,?)',(feature,'account',json.dumps(dict(feature=feature,provider=provider)),'unknown',1))
        calls=[]
        tasks=SimpleNamespace(db_path=str(file),unseal=json.loads,status=lambda q,a:calls.append(q))
        SubtitleRecoveryWorker(tasks).scan();self.assertEqual(calls,['subtitle-removal'])


if __name__=='__main__':unittest.main()
