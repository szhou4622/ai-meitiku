import os from "node:os";
import path from "node:path";

export function resolveDownloadsPath(getPath, {
  homeDirectory = os.homedir(),
  join = path.join,
  isAbsolute = path.isAbsolute,
  onFallback = () => {},
} = {}) {
  try {
    const downloadsPath = getPath("downloads");
    if (typeof downloadsPath === "string" && downloadsPath.trim() && isAbsolute(downloadsPath)) {
      return downloadsPath;
    }
  } catch {
    // A broken OS Downloads mapping must not prevent the application UI from loading.
  }

  let fallbackRoot = "";
  try {
    const userDataPath = getPath("userData");
    if (typeof userDataPath === "string" && userDataPath.trim() && isAbsolute(userDataPath)) {
      fallbackRoot = userDataPath;
    }
  } catch {
    // Continue to the home-directory fallback below.
  }

  if (!fallbackRoot) fallbackRoot = join(homeDirectory, "AI媒体库");
  onFallback({ requestedPath: "downloads", fallback: "userData/Downloads" });
  return join(fallbackRoot, "Downloads");
}
