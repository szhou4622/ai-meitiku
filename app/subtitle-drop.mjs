// Only native files resolved by Electron may enter the processing queue.
export function subtitleDroppedPaths(files, resolvePath) {
  if (!files.length) throw new Error('请从电脑拖入 MP4 视频文件');
  if (typeof resolvePath !== 'function') throw new Error('拖入视频需要在桌面版使用，请使用添加本地视频');
  const paths = [];
  let unsupported = 0, unreadable = 0;
  for (const file of files) {
    let resolved;
    try { resolved = resolvePath(file); } catch { unreadable++; continue; }
    if (!resolved) { unreadable++; continue; }
    if (!/\.mp4$/i.test(resolved)) { unsupported++; continue; }
    paths.push(resolved);
  }
  return { paths, unsupported, unreadable };
}
