import { subtitlePathKey } from './subtitle-batch.mjs';

const normalize = value => String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
const parent = value => value.slice(0, value.lastIndexOf('/'));
export function subtitleInFolder(file, folder) {
  const key = subtitlePathKey(normalize(folder));
  return !!key && subtitlePathKey(normalize(file)).startsWith(`${key}/`);
}
export function subtitleLibraryFolders(videos, indexedFolders = []) {
  const groups = new Map();
  for (const video of videos) {
    const file = normalize(video.localPath), directory = parent(file), root = normalize(video.sourceRoot);
    if (!directory) continue;
    let folder = directory;
    const seen = new Set();
    while (folder) {
      const key = subtitlePathKey(folder);
      if (seen.has(key)) break;
      seen.add(key);
      if (!groups.has(key)) groups.set(key, { path: folder, name: folder.split('/').pop() || folder, paths: new Map() });
      groups.get(key).paths.set(subtitlePathKey(file), video.localPath);
      if (!root || key === subtitlePathKey(root) || !subtitleInFolder(folder, root)) break;
      folder = parent(folder);
    }
  }
  for (const indexed of indexedFolders) {
    if (indexed.available === false || !indexed.path) continue;
    const folder = normalize(indexed.path), key = subtitlePathKey(folder);
    const children = videos.filter(video => subtitleInFolder(video.localPath, folder));
    if (!children.length) continue;
    if (!groups.has(key)) groups.set(key, { path: folder, name: indexed.name || folder.split('/').pop() || folder, paths: new Map() });
    for (const video of children) groups.get(key).paths.set(subtitlePathKey(normalize(video.localPath)), video.localPath);
  }
  return [...groups.values()].map(group => ({ ...group, paths: [...group.paths.values()] }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
}
