const pathKey = value => {
  const normalized = String(value || '').replaceAll('\\', '/');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

export function subtitleSourceVideos(assets, jobs) {
  const outputs = new Set(jobs.map(job => pathKey(job.outputPath)).filter(Boolean));
  return assets.filter(asset => asset.type === 'video' && /\.mp4$/i.test(asset.localPath || '')
    && !asset.deleted && !asset.broken && asset.available !== false
    && asset.collection !== '阿里云去字幕' && !outputs.has(pathKey(asset.localPath)));
}

// Lives at application level so navigating away from the workbench cannot stop syncing.
export function createSubtitleAutoSync({ ready, api, importFile, notify }) {
  let busy = false, stopped = false;
  const failed = new Set();
  return {
    stop() { stopped = true; },
    async tick() {
      if (busy || stopped || !ready()) return;
      busy = true;
      try {
        const state = await api().state();
        for (const job of state.jobs) {
          if (stopped || !ready()) break;
          if (job.status !== 'completed' || job.syncToMediaLibrary !== true || job.importedAt || job.importError || failed.has(job.id)) continue;
          try {
            await importFile(job.outputPath);
            await api().imported(job.id);
            notify('去字幕成片已自动同步到媒体库');
          } catch {
            failed.add(job.id);
            await api().importFailed(job.id).catch(() => {});
            notify('成片已保存，但同步媒体库失败，请在任务中重试同步');
          }
        }
      } finally { busy = false; }
    },
  };
}
