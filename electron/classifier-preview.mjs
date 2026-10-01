const ignoredPreviewFolders = new Set(["outputs", "segments", "output", "分镜", "镜头"]);

function splitPortablePath(filePath) {
  return String(filePath || "").split(/[\\/]+/).filter(Boolean);
}

function stripExtension(fileName) {
  return String(fileName || "").replace(/\.[^.]+$/, "");
}

function formatPreviewTime(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function buildClassifierPreviewMetadata(filePath) {
  const parts = splitPortablePath(filePath);
  const fileName = parts.at(-1) || "";
  const title = stripExtension(fileName);
  const directoryParts = parts.slice(0, -1);
  const segmentMatch = title.match(/(?:镜头|分镜)[_\s-]?(\d+).*?[_\s-](\d{6,9})-(\d{6,9})(?:_|$)/i)
    || title.match(/[_\s-](\d{6,9})-(\d{6,9})(?:_|$)/);
  const hasExplicitIndex = Boolean(segmentMatch?.[3]);
  const segmentIndex = segmentMatch ? Number(hasExplicitIndex ? segmentMatch[1] : 0) || null : null;
  const startMs = segmentMatch ? Number(hasExplicitIndex ? segmentMatch[2] : segmentMatch[1]) : null;
  const endMs = segmentMatch ? Number(hasExplicitIndex ? segmentMatch[3] : segmentMatch[2]) : null;
  const hasGeneratedIntermediateFolder = directoryParts.some((part) => {
    const normalized = part.toLowerCase();
    return ignoredPreviewFolders.has(normalized)
      || /^(?:work|sheets?)[_-]/i.test(part)
      || /(?:镜头拆解|classifier-input|分类输入)-?/i.test(part);
  });
  const directoryTags = directoryParts
    .filter((part) => !/^[A-Za-z]:$/.test(part) && !ignoredPreviewFolders.has(part.toLowerCase()) && !/(?:镜头拆解|classifier-input|分类输入)-/i.test(part))
    .slice(-2);
  // A final classified file can intentionally retain the original segment name,
  // including its shot index and time range. Its classification directories are
  // authoritative; the segment-shaped filename must not erase the final tags.
  const tags = segmentMatch && hasGeneratedIntermediateFolder ? [] : directoryTags;
  const sourceName = title
    .replace(/_(?:镜头|分镜)[_\s-]?\d+.*$/i, "")
    .replace(/_原拍摄日期.*$/i, "")
    .trim() || title;

  return {
    title,
    fileName,
    sourceName,
    tags,
    segmentIndex,
    startMs: Number.isFinite(startMs) ? startMs : null,
    endMs: Number.isFinite(endMs) ? endMs : null,
    timeRange: Number.isFinite(startMs) && Number.isFinite(endMs)
      ? `${formatPreviewTime(startMs)} – ${formatPreviewTime(endMs)}`
      : "",
  };
}
