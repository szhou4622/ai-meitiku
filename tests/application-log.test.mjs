import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ApplicationLog, authorizationFileStatus, diagnosticHandler, redact } from '../electron/application-log.mjs';
test('export re-redacts historical device secrets while retaining usage, errors and task correlation', async t => {
  const { root, log } = fixture(t);
  log.write('info', 'seed');
  const historical = { timestamp: '2026-10-08T00:00:00Z', event: 'license.old',
    deviceCredential: 'private-proof', device_session: 'private-session',
    machineCode: 'v3_' + 'a'.repeat(64), operationId: 'diagnostic-task-id',
    input_tokens: 1234, outputTokens: 567, total_tokens: 1801,
    error: { code: 'EACCES', stack: 'device_credential=private-inline\nstack at line 42' } };
  fs.appendFileSync(path.join(log.root, log.files()[0].name), JSON.stringify(historical) + '\n');
  const file = path.join(root, 'historical.gz');
  await log.export(file, { hasCredential: true, deviceCredential: 'private-supplement',
    licensing: { state: { phase: 'network_error', deviceSession: 'private-nested-session' },
      validationPolicy: { checkIntervalMinutes: 15 },
      secureStorage: { encryptionAvailable: true },
      files: [{ name: 'license-credential.v2.bin', exists: true, bytes: 123 }] } });
  const text = gunzipSync(fs.readFileSync(file)).toString();
  assert.equal(text.includes('private-'), false);
  assert.equal(text.includes('v3_' + 'a'.repeat(64)), false);
  const bundle = JSON.parse(text);
  const event = bundle.records.flatMap(f => f.content.trim().split('\n').map(JSON.parse)).find(e => e.event === 'license.old');
  assert.equal(event.input_tokens, 1234);
  assert.equal(event.outputTokens, 567);
  assert.equal(event.total_tokens, 1801);
  assert.equal(event.operationId, 'diagnostic-task-id');
  assert.equal(event.error.code, 'EACCES');
  assert.match(event.error.stack, /stack at line 42/);
  assert.equal(bundle.supplemental.hasCredential, true);
  assert.equal(bundle.supplemental.licensing.state.phase, 'network_error');
  assert.equal(bundle.supplemental.licensing.state.deviceSession, '[REDACTED]');
  assert.equal(bundle.supplemental.licensing.validationPolicy.checkIntervalMinutes, 15);
  assert.equal(bundle.supplemental.licensing.secureStorage.encryptionAvailable, true);
  assert.equal(bundle.supplemental.licensing.files[0].bytes, 123);
  assert.equal(bundle.formatVersion, 2);
  assert.equal(bundle.coverage.fileCount, bundle.records.length);
});

test('authorization file inventory reports missing and empty proof files without exporting content', t => {
  const { root } = fixture(t);
  const directory = path.join(root, 'license'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'license-credential.v2.bin'), 'private-encrypted-content');
  fs.writeFileSync(path.join(directory, 'license-offline-grant.v1.bin'), '');
  const inventory = authorizationFileStatus(root);
  assert.equal(inventory.find(f => f.name === 'license-credential.v2.bin').bytes, 25);
  assert.equal(inventory.find(f => f.name === 'license-offline-grant.v1.bin').bytes, 0);
  assert.equal(inventory.find(f => f.name === 'license-canonical-recovery.v1.bin').exists, false);
  assert.equal(JSON.stringify(inventory).includes('private-encrypted-content'), false);
});

test('export retains malformed historical lines as redacted diagnostic records', async t => {
  const { root, log } = fixture(t);
  log.write('info', 'seed');
  fs.appendFileSync(path.join(log.root, log.files()[0].name), 'broken device_session=private-session\n');
  const file = path.join(root, 'malformed.gz'); await log.export(file);
  const text = gunzipSync(fs.readFileSync(file)).toString();
  assert.equal(text.includes('private-session'), false);
  const bundle = JSON.parse(text);
  const events = bundle.records.flatMap(f => f.content.trim().split('\n').map(JSON.parse));
  assert.ok(events.some(e => e.event === 'diagnostics.unparsed_record'));
});
function fixture(t, now) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiml-log-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, log: new ApplicationLog({ userDataPath: root, now, metadata: { version: 'test' } }) }; }
test('export preserves operation timing, nested cause, stack and correlation without credentials', async t => {
  const { root, log } = fixture(t);
  const error = new Error('connection refused', { cause: new Error('upstream unavailable') }); error.code = 'ECONNREFUSED';
  await assert.rejects(diagnosticHandler(log, 'video-download-start', () => { throw error; })(null, { token: 'private-token', url: 'https://example.com/video?xsec_token=private-query' }), /ECONNREFUSED.*\n诊断编号/s);
  const file = path.join(root, 'report.gz'); await log.export(file);
  const text = gunzipSync(fs.readFileSync(file)).toString();
  const bundle = JSON.parse(text); const events = bundle.records.flatMap(f => f.content.trim().split('\n').map(JSON.parse));
  const failure = events.find(e => e.event === 'operation.error');
  assert.equal(failure.error.code, 'ECONNREFUSED'); assert.match(failure.error.stack, /connection refused/); assert.equal(failure.error.cause.message, 'upstream unavailable'); assert.equal(failure.operationId, events[0].operationId); assert.equal(typeof failure.durationMs, 'number');
  assert.equal(text.includes('private-token'), false); assert.equal(text.includes('private-query'), false);
});
test('credentials passed as positional arguments or returned by reveal are absent', async t => {
  const { root, log } = fixture(t);
  await diagnosticHandler(log, 'license-reveal-activation-code', () => 'private-license')(null, 'private-input');
  const file = path.join(root, 'report.gz'); await log.export(file);
  const text = gunzipSync(fs.readFileSync(file)).toString(); assert.equal(text.includes('private-license'), false); assert.equal(text.includes('private-input'), false);
  const cleaned = redact({ secret: 'secret-value', message: 'Cookie: sid=private-cookie; auth=private-auth\n{"api_key":"private-key"}\nBearer private-bearer' });
  assert.equal(JSON.stringify(cleaned).includes('private-'), false);
});
test('age and capacity pruning keep recent records and settings survive restart', t => {
  let now = new Date('2026-10-01T00:00:00Z'); const { root, log } = fixture(t, () => now);
  log.write('info', 'old'); const old = path.join(log.root, log.files()[0].name); fs.utimesSync(old, now, now);
  now = new Date('2026-10-20T00:00:00Z'); log.write('error', 'recent'); assert.equal(fs.existsSync(old), false);
  const large = path.join(log.root, 'large.jsonl'); fs.writeFileSync(large, ''); fs.truncateSync(large, 51 * 1048576); fs.utimesSync(large, new Date('2026-10-19'), new Date('2026-10-19'));
  log.save({ retentionDays: 30, maxMegabytes: 50 }); assert.equal(fs.existsSync(large), false); assert.ok(log.snapshot().bytes <= 50 * 1048576);
  const restarted = new ApplicationLog({ userDataPath: root, now: () => now }); assert.deepEqual(restarted.settings, { retentionDays: 30, maxMegabytes: 50 });
});

test('resolved failure results expose their specific cause without changing return contracts', async t => {
  const { log } = fixture(t); let details;
  const result = { ok: false, code: "DISK_FULL", message: "磁盘空间不足" };
  const returned = await diagnosticHandler(log, "storage-management-clear", () => result)({ sender: { isDestroyed: () => false, send: (_channel, value) => { details = value; } } });
  assert.equal(returned, result); assert.match(details.message, /磁盘空间不足/); assert.match(details.message, /DISK_FULL/); assert.match(details.message, /诊断编号/);
});
test('streaming export preserves unicode and its snapshot during retention cleanup', async t => {
  let now = new Date('2026-10-01T00:00:00Z');
  const { root, log } = fixture(t, () => now);
  log.save({ retentionDays: 90 });
  const text = '详细原因："上游超时"\\路径\n'.repeat(10000);
  log.write('error', 'long-error', { text });
  const old = path.join(log.root, log.files()[0].name); fs.utimesSync(old, now, now);
  now = new Date('2026-10-20T00:00:00Z');
  const file = path.join(root, 'streaming.gz');
  const pending = log.export(file);
  log.save({ retentionDays: 7 });
  assert.equal(fs.existsSync(old), false);
  await pending;
  const bundle = JSON.parse(gunzipSync(fs.readFileSync(file)).toString());
  const records = bundle.records.flatMap(f => f.content.trim().split('\n').map(JSON.parse));
  assert.equal(records.find(e => e.event === 'long-error').text, text);
});
