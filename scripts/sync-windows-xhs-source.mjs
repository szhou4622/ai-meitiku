import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");

function sourceMappings(projectRoot, targetRootOverride) {
  const vendorRoot = path.join(projectRoot, "third_party", "video-downloaders", "xhs");
  const targetRoot = targetRootOverride
    ? path.resolve(targetRootOverride)
    : path.join(projectRoot, "bundled-downloaders", "win32-x64", "xhs-runtime", "Lib", "site-packages");
  return [
    [path.join(vendorRoot, "packages", "xhs-core", "src", "xhs_core"), path.join(targetRoot, "xhs_core")],
    [path.join(vendorRoot, "packages", "xhs-adapters", "src", "xhs_adapters"), path.join(targetRoot, "xhs_adapters")],
    [path.join(vendorRoot, "apps", "cli", "src", "xhs_cli"), path.join(targetRoot, "xhs_cli")],
  ];
}

async function packageSourceFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await packageSourceFiles(root, target));
    else if (entry.isFile() && (entry.name.endsWith(".py") || entry.name === "py.typed")) {
      files.push(path.relative(root, target));
    }
  }
  return files.sort();
}

export async function syncWindowsXhsSource({ projectRoot = defaultProjectRoot, targetRoot } = {}) {
  let copied = 0;
  for (const [sourceRoot, packageTargetRoot] of sourceMappings(projectRoot, targetRoot)) {
    for (const relative of await packageSourceFiles(sourceRoot)) {
      const source = path.join(sourceRoot, relative);
      const target = path.join(packageTargetRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      copied += 1;
    }
  }
  return { copied };
}

export async function verifyWindowsXhsSourceParity({ projectRoot = defaultProjectRoot, targetRoot } = {}) {
  const failures = [];
  let checked = 0;
  for (const [sourceRoot, packageTargetRoot] of sourceMappings(projectRoot, targetRoot)) {
    for (const relative of await packageSourceFiles(sourceRoot)) {
      const source = path.join(sourceRoot, relative);
      const target = path.join(packageTargetRoot, relative);
      try {
        const [sourceData, targetData] = await Promise.all([readFile(source), readFile(target)]);
        if (!sourceData.equals(targetData)) failures.push(`${path.relative(projectRoot, target)} 与源码不一致`);
      } catch (error) {
        failures.push(error?.code === "ENOENT"
          ? `${path.relative(projectRoot, target)} 缺失`
          : `${path.relative(projectRoot, target)} 无法校验`);
      }
      checked += 1;
    }
  }
  return { checked, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const synced = await syncWindowsXhsSource();
  const verified = await verifyWindowsXhsSourceParity();
  if (verified.failures.length) throw new Error(verified.failures.join("\n"));
  console.log(`Windows 小红书源码运行时已同步并逐文件校验（${synced.copied} 个文件）`);
}
