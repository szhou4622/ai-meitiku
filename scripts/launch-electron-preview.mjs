import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_LICENSE_STORE_ENV } from "../electron/license-user-data.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(scriptPath));

export function previewEnvironment(environment = process.env, isolated = false) {
  const result = { ...environment };
  result.AI_MEDIA_LIBRARY_PREVIEW_ALL_FEATURES = "true";
  if (isolated) delete result[PRODUCTION_LICENSE_STORE_ENV];
  else result[PRODUCTION_LICENSE_STORE_ENV] = "true";
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const isolated = process.argv.includes("--isolated");
  const require = createRequire(import.meta.url);
  const executable = require("electron");
  const child = spawn(executable, [projectRoot], {
    cwd: projectRoot,
    env: previewEnvironment(process.env, isolated),
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error("Electron preview could not start:", error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
