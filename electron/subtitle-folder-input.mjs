import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

const otherVideo = /\.(?:mov|mkv|avi|webm|m4v|wmv|flv|mpeg|mpg|ts)$/i;

// Read-only discovery. Each file still goes through the existing MP4 probe before being queued.
export async function collectSubtitleFolder(directory, { limit = 200 } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('请选择有效的视频文件夹');
  const paths = [], folders = [directory];
  let unsupported = 0, unreadable = 0, limited = false;
  while (folders.length && !limited) {
    const folder = folders.pop();
    let handle;
    try { handle = await opendir(folder); } catch { unreadable++; continue; }
    try {
      for await (const entry of handle) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) folders.push(file);
        else if (entry.isFile() && /\.mp4$/i.test(entry.name)) {
          if (paths.length >= limit) { limited = true; break; }
          paths.push(file);
        } else if (entry.isFile() && otherVideo.test(entry.name)) unsupported++;
      }
    } catch { unreadable++; }
  }
  paths.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  return { directory, paths, unsupported, unreadable, limited };
}
