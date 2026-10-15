import hashlib
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from oss_subtitle_uploads import DirectSubtitleUploads, OssStorage, PART_SIZE, LIMIT
from ai_media_tasks import TaskError

def box(kind, data): return (len(data)+8).to_bytes(4,'big')+kind+data
VIDEO = box(b'ftyp',b'isom0000')+box(b'mdat',b'x'*4000)+box(b'moov',b'metadata')

class Storage:
    def __init__(self): self.created=0; self.completed=0; self.present=False; self.lost=False; self.uploaded=[]; self.read_bytes=0
    def initiate(self,key): self.created+=1; return 'synthetic-upload'
    def parts(self,*args): return self.uploaded
    def complete(self,*args):
        self.completed+=1; self.present=True
        if self.lost: self.lost=False; raise TimeoutError()
    def head(self,key):
        if not self.present: raise HTTPError('synthetic',404,'missing',{},None)
        return {'size':len(VIDEO),'etag':'final-etag'}
    def read_range(self,key,start,count,total): self.read_bytes+=count; return VIDEO[start:start+count]
    def sign(self,*args,**kwargs): return ('https://synthetic.invalid/scoped-url',{})

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.clock=1000; self.storage=Storage()
        self.store=DirectSubtitleUploads(self.tmp.name,b'k'*32,lambda p:5,self.storage,lambda:self.clock)
        self.body={'request_id':'synthetic-uuid','size_bytes':len(VIDEO),'sha256':hashlib.sha256(VIDEO).hexdigest(),'part_md5':[hashlib.md5(VIDEO).hexdigest()]}
    def start(self):
        r=self.store.init(self.body,'account'); self.id=r['upload_id']
        self.storage.uploaded=[{'number':1,'size':len(VIDEO),'etag':self.body['part_md5'][0]}]
        return r
    def test_ownership_idempotency_encryption_and_signed_part_scope(self):
        first=self.start(); self.assertEqual(first,self.store.init(self.body,'account')); self.assertEqual(self.storage.created,1)
        raw=(Path(self.tmp.name)/(self.id+'.bin')).read_bytes(); self.assertNotIn(b'account',raw)
        with self.assertRaises(TaskError): self.store.part({'upload_id':self.id,'part_number':1},'foreign')
        with self.assertRaises(TaskError): self.store.part({'upload_id':self.id,'part_number':2},'account')
        with self.assertRaises(TaskError): self.store.init({**self.body,'seconds':1},'account')
        with self.assertRaises(TaskError): self.store.init({**self.body,'sha256':'a'*64},'account')
        result=self.store.part({'upload_id':self.id,'part_number':1},'account')
        self.assertEqual(set(result['headers']),{'content-type','content-md5'})
    def test_sparse_probe_skips_video_and_lost_complete_recovers_same_object(self):
        self.start(); self.storage.lost=True
        with self.assertRaises(TimeoutError): self.store.complete({'upload_id':self.id},'account')
        completed=self.store.status({'upload_id':self.id},'account')
        self.assertTrue(completed['completed']); self.assertEqual(completed['verified_seconds'],5)
        self.assertEqual(self.storage.completed,1); self.assertLess(self.storage.read_bytes,100)
        self.assertEqual(self.store.complete({'upload_id':self.id},'account'),completed)
        self.assertEqual(self.storage.completed,1)
    def test_missing_corrupt_parts_expired_and_one_gb_boundary(self):
        self.start(); self.storage.uploaded=[]
        with self.assertRaises(TaskError): self.store.complete({'upload_id':self.id},'account')
        self.storage.uploaded=[{'number':1,'size':len(VIDEO),'etag':'a'*32}]
        with self.assertRaises(TaskError): self.store.complete({'upload_id':self.id},'account')
        self.clock+=72001
        with self.assertRaises(TaskError): self.store.status({'upload_id':self.id},'account')
        for size in [0,LIMIT+1,True]:
            with self.assertRaises(TaskError): self.store.init({**self.body,'size_bytes':size},'account')
        r=self.store.init({**self.body,'request_id':'boundary','size_bytes':LIMIT,'part_md5':['b'*32]*(LIMIT//PART_SIZE)},'account')
        self.assertEqual(r['size_bytes'],LIMIT); self.assertEqual(r['part_count'],128)
    def test_scoped_signature_contains_no_secret_and_signs_md5(self):
        storage=OssStorage('synthetic-id','synthetic-secret','synthetic-bucket')
        url,headers=storage.sign('PUT','aiml-subtitles-temp/key.mp4',{'uploadId':'synthetic','partNumber':1},{'content-md5':'one','content-type':'application/octet-stream'},2000)
        other=storage.sign('PUT','aiml-subtitles-temp/key.mp4',{'uploadId':'synthetic','partNumber':1},{'content-md5':'two','content-type':'application/octet-stream'},2000)[0]
        self.assertNotEqual(url,other); self.assertNotIn('synthetic-secret',url); self.assertNotIn('authorization',headers)
        self.assertIn('Expires=2000',url); self.assertIn('partNumber=1',url)

    def test_direct_adapter_quotes_verified_reference_and_calls_url_api_only(self):
        from aliyun_platform import AliyunSubtitles
        from types import SimpleNamespace
        self.start(); self.store.complete({'upload_id':self.id},'account')
        class Client:
            def erase_video_subtitles_with_options(client, request, options):
                self.assertEqual(request.video_url,'https://synthetic.invalid/scoped-url')
                self.assertFalse(options.autoretry)
                return SimpleNamespace(body=SimpleNamespace(request_id='synthetic-job-123456789'))
            def erase_video_subtitles_advance(client,*args): raise AssertionError('must not relay bytes')
        adapter=AliyunSubtitles('synthetic-id','synthetic-secret',b'k'*32,self.tmp.name,client=Client())
        adapter.direct_uploads=self.store
        region={'BX':0,'BY':.75,'BW':1,'BH':.25}
        q=adapter.quote('subtitle-removal',{'upload_id':self.id,'region':region,'consent':True},'account')
        self.assertEqual(q['payload']['verified_seconds'],5)
        adapter.resume=lambda *args: ('result','receipt')
        import sys
        from unittest.mock import patch
        modules={'alibabacloud_videoenhan20200320':SimpleNamespace(models=SimpleNamespace(EraseVideoSubtitlesRequest=SimpleNamespace)),
                 'alibabacloud_tea_util.models':SimpleNamespace(RuntimeOptions=SimpleNamespace)}
        with patch.dict(sys.modules, modules):
            self.assertEqual(adapter.execute(q,'account','a'*40),('result','receipt'))
        self.assertEqual(adapter.checkpoint('a'*40)['job_id'],'synthetic-job-123456789')

if __name__=='__main__': unittest.main()
