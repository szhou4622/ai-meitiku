import base64
import http.client
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch
import io
from pathlib import Path
from http.server import ThreadingHTTPServer
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from ai_media_platform import APP, AAD, PREFIX, FIELDS, load_vault, build_handler, central_consumption_enabled


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.key = self.root / 'key'
        self.vault = self.root / 'vault'
        self.payload = {'app_name': APP, 'providers': {
            p: {k: 'synthetic-only-' + k for k in fields} for p, fields in FIELDS.items()}}
        self.write(self.payload)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, payload):
        key, iv = os.urandom(32), os.urandom(12)
        encrypted = AESGCM(key).encrypt(iv, json.dumps(payload).encode(), AAD)
        env = {'schema': 1, 'app_name': APP, 'cipher': 'AES-256-GCM',
               'iv': base64.b64encode(iv).decode(), 'tag': base64.b64encode(encrypted[-16:]).decode(),
               'ciphertext': base64.b64encode(encrypted[:-16]).decode()}
        self.key.write_bytes(key)
        self.vault.write_text(json.dumps(env))
        self.key.chmod(0o600)
        self.vault.chmod(0o600)

    def load(self):
        return load_vault(self.key, self.vault, os.getuid())

    def test_roundtrip(self):
        self.assertEqual(self.load(), self.payload['providers'])

    def test_tamper_rejected(self):
        env = json.loads(self.vault.read_text())
        raw = bytearray(base64.b64decode(env['ciphertext']))
        raw[0] ^= 1
        env['ciphertext'] = base64.b64encode(raw).decode()
        self.vault.write_text(json.dumps(env))
        with self.assertRaises(Exception):
            self.load()

    def test_wrong_application(self):
        self.payload['app_name'] = 'another-app'
        self.write(self.payload)
        with self.assertRaises(ValueError):
            self.load()

    def test_file_permissions(self):
        self.key.chmod(0o644)
        with self.assertRaises(ValueError):
            self.load()

    def test_directory_permissions(self):
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            self.load()

    def test_symlink_rejected(self):
        original = self.root / 'real-key'
        self.key.rename(original)
        self.key.symlink_to(original)
        with self.assertRaises(OSError):
            self.load()


class GatewayTests(unittest.TestCase):
    def setUp(self):
        def auth(headers, **kwargs):
            if headers.get('X-Test-Proof') == 'foreign':
                return {'app_name': 'another-app'}
            if headers.get('X-Test-Proof') != 'synthetic':
                exc = RuntimeError('synthetic-secret-do-not-return')
                exc.status = 401
                raise exc
            return {'app_name': APP}
        providers = {p: {k: 'synthetic-secret-do-not-return' for k in fields} for p, fields in FIELDS.items()}
        self.enabled = False
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), build_handler(auth, providers, lambda: self.enabled))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body=None, proof='synthetic', path='capabilities', method='POST'):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        raw = body if isinstance(body, str) else json.dumps(body if body is not None else {'app_name': APP})
        conn.request(method, PREFIX + path, raw if method == 'POST' else None,
                     {'Content-Type': 'application/json', 'X-Test-Proof': proof})
        result = conn.getresponse()
        text = result.read().decode()
        self.assertNotIn('synthetic-secret', text)
        conn.close()
        return result.status, json.loads(text)

    def test_authenticated_metadata(self):
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertFalse(body['generation_enabled'])
        self.assertFalse(body['consumption_enabled'])
        self.assertEqual(set(body['providers']), set(FIELDS))
        self.assertTrue(all(p == {'configured': True, 'validated': False} for p in body['providers'].values()))

    def test_missing_proof(self):
        self.assertEqual(self.request(proof='')[0], 401)

    def test_foreign_proof(self):
        self.assertEqual(self.request(proof='foreign')[0], 403)

    def test_body_scope(self):
        self.assertEqual(self.request({'app_name': 'another-app'})[0], 403)

    def test_untrusted_price_rejected(self):
        self.assertEqual(self.request({'app_name': APP, 'cost_cny': '0'})[0], 400)

    def test_duplicate_keys(self):
        self.assertEqual(self.request('{"app_name":"ai-media-library","app_name":"ai-media-library"}')[0], 400)

    def test_no_internal_or_supplier_execution(self):
        for path in ('internal/commit', 'chat/completions', 'platform-api.masterkey'):
            self.assertEqual(self.request(path=path)[0], 404)

    def test_health(self):
        status, body = self.request(path='health', method='GET')
        self.assertEqual(status, 200)
        self.assertFalse(body['consumption_enabled'])

    def test_switch_tracks_authority_without_enabling_generation(self):
        self.enabled = True
        for path, method in (('health', 'GET'), ('capabilities', 'POST')):
            status, body = self.request(path=path, method=method)
            self.assertEqual(status, 200)
            self.assertTrue(body['consumption_enabled'])
            self.assertFalse(body['generation_enabled'])


class AuthorityTests(unittest.TestCase):
    def test_authoritative_enabled(self):
        with patch('ai_media_platform.urlopen', return_value=io.BytesIO(json.dumps(
                {'ok': True, 'app_name': APP, 'consumption_enabled': True}).encode())):
            self.assertTrue(central_consumption_enabled())

    def test_unavailable_fails_closed(self):
        with patch('ai_media_platform.urlopen', side_effect=OSError('synthetic')):
            self.assertFalse(central_consumption_enabled())

    def test_foreign_or_invalid_state_fails_closed(self):
        for state in ({'ok': True, 'app_name': 'foreign', 'consumption_enabled': True},
                      {'ok': True, 'app_name': APP, 'consumption_enabled': 'true'}):
            with patch('ai_media_platform.urlopen', return_value=io.BytesIO(json.dumps(state).encode())):
                self.assertFalse(central_consumption_enabled())


if __name__ == '__main__':
    unittest.main()
