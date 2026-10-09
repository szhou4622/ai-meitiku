import test from 'node:test';
import assert from 'node:assert/strict';
import { subtitleDroppedPaths } from '../app/subtitle-drop.mjs';
import { SUBTITLE_RESULT_COLLECTION, normalizeSubtitleCollection, subtitleSourceVideos } from '../app/subtitle-library-sync.mjs';


test('drop reads every native MP4 including uppercase names; other files never enter the queue', () => {
  const files = [{ name: 'a.mp4', path: '/a.mp4' }, { name: 'b.MP4', path: 'C:\\Video\\b.MP4' }, { name: 'image.png', path: '/image.png' }, { name: 'folder', path: '/folder' }];
  const result = subtitleDroppedPaths(files, file => file.path);
  assert.deepEqual(result.paths, ['/a.mp4', 'C:\\Video\\b.MP4']);
  assert.equal(result.unsupported, 2);
  assert.equal(result.unreadable, 0);
});
test('unreadable dropped file does not abort valid files and browser-only files cannot silently succeed', () => {
  const result = subtitleDroppedPaths([{ name: 'error.mp4' }, { name: 'browser.mp4' }, { name: 'ok.mp4' }], file => { if (file.name === 'error.mp4') throw Error('invalid native file'); return file.name === 'ok.mp4' ? '/ok.mp4' : ''; });
  assert.deepEqual(result.paths, ['/ok.mp4']);
  assert.equal(result.unreadable, 2);
  assert.throws(() => subtitleDroppedPaths([], () => ''), /拖入/);
  assert.throws(() => subtitleDroppedPaths([{}], undefined), /桌面版/);
});
test('legacy results are grouped as 已去字幕 without losing metadata or reappearing as original videos', () => {
  const old = { id: 10, type: 'video', localPath: '/old.mp4', collection: '阿里云去字幕', tags: ['精选'], favorite: true, deleted: false };
  const migrated = { ...old, collection: normalizeSubtitleCollection(old.collection) };
  assert.equal(migrated.collection, SUBTITLE_RESULT_COLLECTION);
  assert.equal(migrated.id, old.id);
  assert.deepEqual(migrated.tags, old.tags);
  assert.equal(migrated.favorite, true);
  assert.equal(normalizeSubtitleCollection('用户项目'), '用户项目');
  assert.deepEqual(subtitleSourceVideos([old, migrated, { type: 'video', localPath: '/new.mp4', collection: SUBTITLE_RESULT_COLLECTION }, { type: 'video', localPath: '/input.mp4', collection: '用户项目' }], []), [{ type: 'video', localPath: '/input.mp4', collection: '用户项目' }]);
});
