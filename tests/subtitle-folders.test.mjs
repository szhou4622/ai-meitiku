import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectSubtitleFolder } from '../electron/subtitle-folder-input.mjs';
import { subtitleLibraryFolders, subtitleInFolder } from '../app/subtitle-folders.mjs';
import { subtitleSourceVideos } from '../app/subtitle-library-sync.mjs';

test('folder input collects nested MP4 files, reports other video formats and does not follow links', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subtitle-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '子目录'));
  for (const name of ['2.MP4', '1.mp4', 'photo.jpg', 'clip.mov', '子目录/3.mp4']) await writeFile(path.join(root, name), 'fixture');
  await symlink(root, path.join(root, '子目录', 'loop'), 'dir');
  await symlink(path.join(root, '1.mp4'), path.join(root, 'copy.mp4'));
  const result = await collectSubtitleFolder(root);
  assert.deepEqual(new Set(result.paths.map(file => path.relative(root, file))), new Set(['1.mp4', '2.MP4', '子目录/3.mp4']));
  assert.equal(result.unsupported, 1);
  assert.equal(result.limited, false);
  assert.equal(result.unreadable, 0);
});

test('empty folder, invalid folder and batch cap have explicit results', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subtitle-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual((await collectSubtitleFolder(root)).paths, []);
  await assert.rejects(collectSubtitleFolder('relative'), /有效/);
  for (const name of ['1.mp4', '2.mp4', '3.mp4']) await writeFile(path.join(root, name), 'fixture');
  const capped = await collectSubtitleFolder(root, { limit: 2 });
  assert.equal(capped.paths.length, 2);
  assert.equal(capped.limited, true);
  await assert.rejects(collectSubtitleFolder(path.join(root, '1.mp4')), /有效/);
});

test('library folder selection includes descendants, deduplicates and excludes unavailable and generated videos', () => {
  const assets = [
    { type: 'video', name: 'a', localPath: '/素材/产品/a.mp4', sourceRoot: '/素材' },
    { type: 'video', name: 'a duplicate', localPath: '/素材/产品/a.mp4', sourceRoot: '/素材' },
    { type: 'video', name: 'b', localPath: '/素材/产品/近景/b.mp4', sourceRoot: '/素材' },
    { type: 'video', name: 'result', localPath: '/素材/产品/result.mp4', sourceRoot: '/素材' },
    { type: 'video', name: 'offline', localPath: '/素材/产品/offline.mp4', sourceRoot: '/素材', available: false },
    { type: 'image', name: 'photo', localPath: '/素材/产品/photo.jpg', sourceRoot: '/素材' },
    { type: 'video', name: 'different', localPath: '/素材/产品二/c.mp4', sourceRoot: '/素材' },
  ];
  const folders = subtitleLibraryFolders(subtitleSourceVideos(assets, [{ outputPath: '/素材/产品/result.mp4' }]));
  assert.deepEqual(folders.find(folder => folder.path === '/素材/产品').paths, ['/素材/产品/a.mp4', '/素材/产品/近景/b.mp4']);
  assert.equal(folders.find(folder => folder.path === '/素材').paths.length, 3);
  assert.ok(!folders.some(folder => folder.path === '/'));
  assert.equal(subtitleInFolder('/素材/产品二/c.mp4', '/素材/产品'), false);
});

test('Windows folder paths use case-insensitive boundaries; same names in different folders stay separate', () => {
  const folders = subtitleLibraryFolders([
    { localPath: 'C:\\Media\\Take\\1.mp4', sourceRoot: 'c:\\media' },
    { localPath: 'c:\\media\\take\\close\\2.mp4', sourceRoot: 'C:\\Media' },
    { localPath: 'C:\\Other\\Take\\3.mp4', sourceRoot: 'C:\\Other' },
  ]);
  assert.equal(folders.find(folder => folder.path.toLowerCase() === 'c:/media/take').paths.length, 2);
  assert.equal(folders.filter(folder => folder.name.toLowerCase() === 'take').length, 2);
  assert.equal(subtitleInFolder('c:\\MEDIA\\Take\\close\\2.mp4', 'C:\\Media\\take'), true);
  assert.equal(subtitleInFolder('C:\\Media\\Take2\\3.mp4', 'C:\\Media\\Take'), false);
});

test('indexed parent folders remain selectable even when asset source roots are nested categories', () => {
  const folders = subtitleLibraryFolders([
    { localPath: '/小方/分类一/a.mp4', sourceRoot: '/小方/分类一' },
    { localPath: '/小方/分类二/b.mp4', sourceRoot: '/小方/分类二' },
  ], [{ path: '/小方', name: '小方' }, { path: '/失联', available: false }]);
  assert.equal(folders.find(folder => folder.path === '/小方').paths.length, 2);
  assert.ok(!folders.some(folder => folder.path === '/失联'));
});
