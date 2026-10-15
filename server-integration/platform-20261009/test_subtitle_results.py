import tempfile
import unittest
from pathlib import Path
from subtitle_results import SubtitleResults, RETENTION
from ai_media_tasks import TaskError


class Storage:
    def __init__(self): self.values = {}; self.uploads = 0; self.fail = False
    def upload_file(self, file, key):
        self.uploads += 1
        if self.fail: raise TimeoutError('synthetic upload interruption')
        self.values[key] = file.read_bytes()
    def head(self, key): return {'size': len(self.values[key])}
    def sign(self, method, key, expires): return ('https://test.aliyuncs.com/' + key + '?Expires=' + str(expires), {})


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.now = 1000; self.storage = Storage(); self.key = b'k' * 32
        self.store = self.create(); self.quote = 'a' * 40
    def create(self): return SubtitleResults(self.tmp.name, self.key, self.storage, lambda: self.now)
    def save(self):
        file = Path(self.tmp.name) / 'download.mp4'; file.write_bytes(b'verified-video')
        return self.store.preserve(self.quote, file, 5)
    def test_refresh_after_restart_changes_url_but_not_output_or_generation(self):
        value = self.save(); first = self.store.public(self.quote)
        self.now += 1000; restarted = self.create(); second = restarted.public(self.quote)
        self.assertNotEqual(first['VideoUrl'], second['VideoUrl'])
        self.assertEqual(first['sha256'], second['sha256']); self.assertEqual(self.storage.uploads, 1)
        self.assertEqual(second['usage']['output_seconds'], 5)
        self.assertNotIn(value['key'].encode(), self.store.file(self.quote).read_bytes())
        self.assertFalse(self.store.file(self.quote, '.mp4').exists())
    def test_failed_remote_store_recovers_verified_local_bytes_without_supplier_call(self):
        self.storage.fail = True
        with self.assertRaises(TimeoutError): self.save()
        self.assertTrue(self.store.file(self.quote, '.mp4').exists())
        self.storage.fail = False; restarted = self.create()
        self.assertEqual(restarted.public(self.quote)['size_bytes'], len(b'verified-video'))
        self.assertEqual(self.storage.uploads, 2)
    def test_retention_and_quote_scope_are_enforced(self):
        self.save(); self.now += RETENTION
        with self.assertRaises(TaskError) as error: self.store.public(self.quote)
        self.assertEqual(error.exception.code, 'SUBTITLE_RESULT_EXPIRED')
        with self.assertRaises(TaskError): self.store.public('../other')
        with self.assertRaises(TaskError): self.store.public('b' * 40)


if __name__ == '__main__': unittest.main()
