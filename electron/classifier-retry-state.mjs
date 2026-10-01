import { countClassifierCsvDataRows } from "./classifier-run-artifacts.mjs";

export function countClassifierRetryTasks(payload) {
  const result = payload?.result && !Array.isArray(payload.result) ? payload.result : payload;
  if (!result || typeof result !== "object" || Array.isArray(result)) return 0;
  const failedCount = Math.max(0, Number(result.failed_count) || 0);
  const pendingCount = Math.max(0, Number(result.pending_count) || 0);
  return failedCount + pendingCount;
}

async function countRetryListRows(result, readText) {
  if (!result || typeof result !== "object" || typeof readText !== "function") return 0;
  let count = 0;
  for (const key of ["failed", "pending"]) {
    if (typeof result[key] !== "string" || !result[key].trim()) continue;
    try {
      count += countClassifierCsvDataRows(await readText(result[key], "utf8"));
    } catch {
      // A numeric counter without its matching list is not a safe retry plan.
    }
  }
  return count;
}

export async function readClassifierRetryState(activeJobPath, readJson, readText) {
  let state;
  try {
    state = await readJson(activeJobPath);
  } catch {
    return { retryTaskCount: 0, retryPayload: null };
  }

  const savedRetryPayload = state?.retryPayload && typeof state.retryPayload === "object" ? state.retryPayload : null;
  const networkSafeSources = Array.isArray(state?.networkSafe?.failedSourcePaths)
    ? state.networkSafe.failedSourcePaths.filter((item) => typeof item === "string" && item)
    : [];
  let retryTaskCount = savedRetryPayload && Number.isFinite(Number(state?.retryTaskCount))
    ? Math.max(0, Number(state.retryTaskCount))
    : networkSafeSources.length;

  if (!savedRetryPayload && state?.resultPath) {
    try {
      const savedResult = await readJson(state.resultPath);
      const result = savedResult?.result && !Array.isArray(savedResult.result) ? savedResult.result : null;
      retryTaskCount = await countRetryListRows(result, readText);
    } catch {
      retryTaskCount = 0;
    }
  }

  const networkSafeRetryCommand = ["classify", "split"].includes(state?.networkSafe?.retryCommand)
    ? state.networkSafe.retryCommand
    : "classify";
  const retryPayload = retryTaskCount > 0 && (savedRetryPayload || state?.payload?.folder)
    ? savedRetryPayload
      ? savedRetryPayload
      : networkSafeSources.length
      ? { ...state.payload, command: networkSafeRetryCommand, source_paths: networkSafeSources, workers: 1, network_safe_mode: true }
      : { ...state.payload, command: "review" }
    : null;

  return { retryTaskCount, retryPayload };
}
