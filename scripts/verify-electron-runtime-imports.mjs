import { builtinModules } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportedExtensions = new Set([".mjs", ".cjs", ".js"]);
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), "electron"]);

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
}

function runtimeSpecifiers(source) {
  const values = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.add(match[1]);
  }
  return [...values];
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name))) files.push(target);
  }
  return files;
}

async function existingFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveRelativeImport(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base];
  if (!path.extname(base)) {
    for (const extension of supportedExtensions) candidates.push(`${base}${extension}`);
    for (const extension of supportedExtensions) candidates.push(path.join(base, `index${extension}`));
  }
  for (const candidate of candidates) {
    if (await existingFile(candidate)) return candidate;
  }
  return null;
}

function includedByBuildFiles(relativePath, buildFiles) {
  const normalized = relativePath.split(path.sep).join("/");
  return buildFiles.some((entry) => {
    if (typeof entry !== "string" || entry.startsWith("!")) return false;
    const pattern = entry.replaceAll("\\", "/").replace(/^\.\//, "");
    if (pattern === normalized) return true;
    if (pattern.endsWith("/**/*")) return normalized.startsWith(pattern.slice(0, -4));
    return false;
  });
}

export async function verifyElectronRuntimeImports({ projectRoot, electronDirectory = path.join(projectRoot, "electron") }) {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const dependencies = new Set(Object.keys(manifest.dependencies || {}));
  const buildFiles = Array.isArray(manifest.build?.files) ? manifest.build.files : [];
  const failures = [];
  const queue = await sourceFiles(electronDirectory);
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of runtimeSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const target = await resolveRelativeImport(file, specifier);
        const importer = path.relative(projectRoot, file);
        if (!target) {
          failures.push(`${importer} -> ${specifier} (相对导入文件不存在)`);
          continue;
        }
        const relativeTarget = path.relative(projectRoot, target);
        if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
          failures.push(`${importer} -> ${specifier} (相对导入越出项目目录)`);
          continue;
        }
        if (!includedByBuildFiles(relativeTarget, buildFiles)) {
          failures.push(`${importer} -> ${specifier} (${relativeTarget} 未包含在 build.files，安装包启动时会缺失)`);
        }
        if (supportedExtensions.has(path.extname(target))) queue.push(target);
        continue;
      }
      if (specifier.startsWith("/") || specifier.startsWith("file:") || builtins.has(specifier)) continue;
      const dependency = packageName(specifier);
      if (!dependencies.has(dependency)) {
        failures.push(`${path.relative(projectRoot, file)} -> ${specifier} (缺少 dependencies.${dependency})`);
      }
    }
  }
  if (failures.length) {
    throw new Error(`Electron 主进程存在未声明或未打包的运行依赖，已阻止打包：\n${failures.join("\n")}`);
  }
  return { checkedFiles: visited.size, dependencies: [...dependencies].sort() };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await verifyElectronRuntimeImports({ projectRoot });
  console.log(`Electron 主进程运行依赖检查通过（${result.checkedFiles} 个文件）`);
}
