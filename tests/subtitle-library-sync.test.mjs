import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubtitleAutoSync, subtitleSourceVideos } from '../app/subtitle-library-sync.mjs';

function fixture(jobs, options = {}) {
  const events = [];
  const api = {
    state: async () => ({ jobs }),
    imported: async id => { events.push(`marked:${id}`); jobs.find(job => job.id === id).importedAt = 'saved'; },
    importFailed: async id => { events.push(`failed:${id}`); jobs.find(job => job.id === id).importError = 'failed'; },
    ...options.api,
  };
  const sync = createSubtitleAutoSync({ ready: () => true, api: () => api,
    importFile: async path => events.push(`saved:${path}`), notify: () => {}, ...options, ...(options.api ? { api: () => api } : {}) });
  return { sync, events, api };
}
const completed = (id, extra = {}) => ({ id, status: 'completed', outputPath: `/${id}.mp4`, syncToMediaLibrary: true, ...extra });

test('only opted-in completed tasks sync, and the index is saved before the marker', async () => {
  const jobs = [completed('ready'), completed('working', { status: 'processing' }), completed('off', { syncToMediaLibrary: false }), completed('old', { syncToMediaLibrary: undefined }), completed('done', { importedAt: 'saved' })];
  const { sync, events } = fixture(jobs);
  await sync.tick(); await sync.tick();
  assert.deepEqual(events, ['saved:/ready.mp4', 'marked:ready']);
});
test('waits for media library hydration and prevents concurrent duplicate imports', async () => {
  let ready = false, release, imports = 0;
  const { sync, events } = fixture([completed('ready')], { ready: () => ready, importFile: () => { imports++; return new Promise(resolve => { release = resolve; }); } });
  await sync.tick(); assert.equal(imports, 0);
  ready = true; const pending = sync.tick(); await new Promise(resolve => setImmediate(resolve));
  await sync.tick(); assert.equal(imports, 1);
  release(); await pending; assert.deepEqual(events, ['marked:ready']);
});
test('failed index save does not mark imported or retry continuously, including after restart', async () => {
  const jobs = [completed('ready')];
  const { sync, events } = fixture(jobs, { importFile: async () => { throw new Error('disk full'); } });
  await sync.tick(); await sync.tick(); assert.deepEqual(events, ['failed:ready']);
  const restarted = fixture(jobs); await restarted.sync.tick(); assert.deepEqual(restarted.events, []);
});
test('pending opted-in job resumes after restart, stopped worker cannot import', async () => {
  const jobs = [completed('ready')];
  const old = fixture(jobs); old.sync.stop(); await old.sync.tick(); assert.deepEqual(old.events, []);
  const restarted = fixture(jobs); await restarted.sync.tick(); assert.deepEqual(restarted.events, ['saved:/ready.mp4', 'marked:ready']);
});
test('failed marker persistence offers retry without repeatedly rewriting library', async () => {
  const { sync, events } = fixture([completed('ready')], { api: { imported: async () => { throw new Error('storage failed'); } } });
  await sync.tick(); await sync.tick(); assert.deepEqual(events, ['saved:/ready.mp4', 'failed:ready']);
});
test('source picker excludes generated outputs and unavailable files without guessing from names', () => {
  const asset = (localPath, extra = {}) => ({ localPath, type: 'video', ...extra });
  const originals = [asset('/input/原片.mp4'), asset('/input/去字幕教程.mp4')];
  const assets = [...originals, asset('/result/done.mp4'), asset('C:\\OUTPUT\\DONE.MP4'), asset('/result/other.mp4', { collection: '阿里云去字幕' }), asset('/gone.mp4', { deleted: true }), asset('/broken.mp4', { broken: true }), asset('/offline.mp4', { available: false }), asset('/image.mp4', { type: 'image' })];
  assert.deepEqual(subtitleSourceVideos(assets, [{ outputPath: '/result/done.mp4' }, { outputPath: 'c:/output/done.mp4' }]), originals);
});
