import io
import json
import tempfile
import unittest
from pathlib import Path
from subtitle_uploads import SubtitleUploads, LIMIT, CHUNK
from aliyun_platform import AliyunSubtitles
from ai_media_tasks import TaskError


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.clock = 1000
        self.store = SubtitleUploads(self.tmp.name, b'k' * 32, lambda p: 5, lambda: self.clock)

    def test_streamed_large_file_ownership_expiry_encrypted_metadata(self):
        class Stream:
            remaining = 40 * CHUNK
            def read(self, size):
                self.assert_size = size
                if size > CHUNK: raise AssertionError('unbounded read')
                self.remaining -= size
                return b'x' * size
        r = self.store.receive(Stream(), 40 * CHUNK, 'synthetic-private-account')
        file, item = self.store.resolve(r['upload_id'], 'synthetic-private-account')
        self.assertEqual(file.stat().st_size, 40 * CHUNK)
        self.assertEqual(item['seconds'], 5)
        self.assertNotIn(b'synthetic-private-account', (Path(self.tmp.name)/(r['upload_id']+'.bin')).read_bytes())
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(TaskError): self.store.resolve(r['upload_id'], 'other-account')
        self.clock += 86401
        with self.assertRaises(TaskError): self.store.resolve(r['upload_id'], 'synthetic-private-account')
        self.store.expire(); self.assertFalse(file.exists())

    def test_oversize_invalid_reference_and_incomplete_upload_leave_no_file(self):
        with self.assertRaises(TaskError) as err: self.store.receive(io.BytesIO(), LIMIT+1, 'owner')
        self.assertEqual(err.exception.status, 413)
        with self.assertRaises(TaskError): self.store.receive(io.BytesIO(b'abc'), 10, 'owner')
        with self.assertRaises(TaskError): self.store.resolve('../../file', 'owner')
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_quote_uses_server_probed_reference_not_client_duration_or_path(self):
        adapter = AliyunSubtitles('fake', 'fake', b'k'*32, self.tmp.name, probe_video=lambda p: 1900)
        r = adapter.uploads.receive(io.BytesIO(b'fake-mp4'), 8, 'owner')
        payload = {'upload_id':r['upload_id'], 'region':{'BX':0,'BY':.75,'BW':1,'BH':.25}, 'consent':True}
        q = adapter.quote('subtitle-removal', payload, 'owner')
        self.assertEqual(q['payload']['verified_seconds'], 1900)
        self.assertNotIn('video', q['payload'])
        self.assertNotIn(self.tmp.name, json.dumps(q))
        for change in ({'duration':1}, {'upload_id':'a'*48}):
            with self.assertRaises(TaskError): adapter.quote('subtitle-removal', {**payload,**change}, 'owner')
        with self.assertRaises(TaskError): adapter.quote('subtitle-removal', payload, 'other-owner')

if __name__ == '__main__': unittest.main()
