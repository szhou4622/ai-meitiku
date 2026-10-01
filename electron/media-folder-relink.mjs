import path from "node:path";

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathKey(value, platform) {
  const api = pathApi(platform);
  const resolved = api.resolve(String(value || ""));
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(rootPath, candidatePath, platform) {
  const api = pathApi(platform);
  const relative = api.relative(api.resolve(rootPath), api.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

function replaceRoot(candidatePath, oldRoot, newRoot, platform) {
  if (!isInsideOrEqual(oldRoot, candidatePath, platform)) return candidatePath;
  const api = pathApi(platform);
  return api.join(api.resolve(newRoot), api.relative(api.resolve(oldRoot), api.resolve(candidatePath)));
}

export function buildFolderRelinkPlan({
  oldRoot,
  newRoot,
  folders = [],
  assets = [],
  availableDirectories = [],
  mediaRecords = [],
  platform = process.platform,
} = {}) {
  const api = pathApi(platform);
  if (!api.isAbsolute(String(oldRoot || "")) || !api.isAbsolute(String(newRoot || ""))) {
    throw new Error("重新关联的文件夹路径无效");
  }
  const resolvedOldRoot = api.resolve(oldRoot);
  const resolvedNewRoot = api.resolve(newRoot);
  const oldRootKey = pathKey(resolvedOldRoot, platform);

  const subtreeKeys = new Set([oldRootKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (!folder?.path || !folder?.parentPath) continue;
      const folderKey = pathKey(folder.path, platform);
      if (!subtreeKeys.has(folderKey) && subtreeKeys.has(pathKey(folder.parentPath, platform))) {
        subtreeKeys.add(folderKey);
        changed = true;
      }
    }
  }

  const relinkFolders = folders.filter((folder) => folder?.path && subtreeKeys.has(pathKey(folder.path, platform)));
  if (!relinkFolders.length) throw new Error("媒体库中没有找到要重新关联的文件夹记录");

  const folderPathMap = new Map(relinkFolders.map((folder) => [
    pathKey(folder.path, platform),
    replaceRoot(folder.path, resolvedOldRoot, resolvedNewRoot, platform),
  ]));
  const collision = folders.find((folder) => folder?.path
    && !subtreeKeys.has(pathKey(folder.path, platform))
    && pathKey(folder.path, platform) === pathKey(resolvedNewRoot, platform));
  if (collision) {
    throw new Error(`新位置已被媒体库中的文件夹“${collision.name || api.basename(collision.path)}”使用，未进行覆盖`);
  }

  const availableDirectoryKeys = new Set(availableDirectories.map((item) => pathKey(item, platform)));
  const mappedFolders = folders.map((folder) => {
    const folderKey = pathKey(folder.path, platform);
    if (!subtreeKeys.has(folderKey)) return folder;
    const nextPath = folderPathMap.get(folderKey);
    const nextParentPath = folder.parentPath && subtreeKeys.has(pathKey(folder.parentPath, platform))
      ? folderPathMap.get(pathKey(folder.parentPath, platform))
      : folder.parentPath;
    return {
      ...folder,
      path: nextPath,
      name: folderKey === oldRootKey ? api.basename(resolvedNewRoot) : folder.name || api.basename(nextPath),
      ...(nextParentPath ? { parentPath: nextParentPath } : { parentPath: undefined }),
      available: availableDirectoryKeys.has(pathKey(nextPath, platform)),
    };
  });

  const folderByPath = new Map();
  for (const folder of mappedFolders) {
    if (!folder?.path) continue;
    const key = pathKey(folder.path, platform);
    const existing = folderByPath.get(key);
    folderByPath.set(key, existing ? { ...existing, ...folder } : folder);
  }
  const discoveredDirectories = [...new Set(availableDirectories
    .filter((directoryPath) => typeof directoryPath === "string" && isInsideOrEqual(resolvedNewRoot, directoryPath, platform))
    .map((directoryPath) => api.resolve(directoryPath)))]
    .sort((left, right) => left.length - right.length);
  let newFolderCount = 0;
  for (const directoryPath of discoveredDirectories) {
    const key = pathKey(directoryPath, platform);
    const existing = folderByPath.get(key);
    if (!existing) newFolderCount += 1;
    const isRoot = key === pathKey(resolvedNewRoot, platform);
    folderByPath.set(key, {
      ...existing,
      path: directoryPath,
      name: isRoot ? api.basename(resolvedNewRoot) : existing?.name || api.basename(directoryPath),
      ...(isRoot ? { parentPath: undefined } : { parentPath: api.dirname(directoryPath) }),
      available: true,
      indexMode: "exact",
    });
  }
  const nextFolders = [...folderByPath.values()];

  const destinationFolderPaths = nextFolders
    .filter((folder) => folder?.path && isInsideOrEqual(resolvedNewRoot, folder.path, platform))
    .map((folder) => folder.path)
    .sort((left, right) => right.length - left.length);
  const destinationFolderFor = (filePath) => destinationFolderPaths
    .find((folderPath) => isInsideOrEqual(folderPath, filePath, platform)) || resolvedNewRoot;

  const recordsByPath = new Map(mediaRecords.map((record) => [pathKey(record.path, platform), record]));
  const matchedRecordKeys = new Set();
  let reconnectedAssets = 0;
  let missingAssets = 0;
  const nextAssets = assets.map((asset) => {
    const belongsToOldTree = asset?.sourceRoot && subtreeKeys.has(pathKey(asset.sourceRoot, platform));
    const alreadyAtDestination = typeof asset?.localPath === "string" && isInsideOrEqual(resolvedNewRoot, asset.localPath, platform);
    if (!belongsToOldTree && !alreadyAtDestination) return asset;
    const nextLocalPath = belongsToOldTree && typeof asset.localPath === "string" && isInsideOrEqual(resolvedOldRoot, asset.localPath, platform)
      ? replaceRoot(asset.localPath, resolvedOldRoot, resolvedNewRoot, platform)
      : asset.localPath;
    const record = nextLocalPath ? recordsByPath.get(pathKey(nextLocalPath, platform)) : null;
    if (!record) {
      missingAssets += 1;
      return { ...asset, localPath: nextLocalPath, sourceRoot: nextLocalPath ? destinationFolderFor(nextLocalPath) : resolvedNewRoot, src: "", available: false, broken: true };
    }
    matchedRecordKeys.add(pathKey(record.path, platform));
    reconnectedAssets += 1;
    return {
      ...asset,
      localPath: record.path,
      sourceRoot: destinationFolderFor(record.path),
      type: record.type,
      modifiedAt: record.modifiedAt,
      sizeBytes: record.sizeBytes,
      src: record.url,
      available: true,
      broken: false,
    };
  });

  const occupiedAssetKeys = new Set(nextAssets
    .filter((asset) => typeof asset?.localPath === "string")
    .map((asset) => pathKey(asset.localPath, platform)));
  const newRecords = mediaRecords
    .filter((record) => !matchedRecordKeys.has(pathKey(record.path, platform)) && !occupiedAssetKeys.has(pathKey(record.path, platform)))
    .map((record) => ({
      ...record,
      sourceRoot: destinationFolderFor(record.path),
    }));

  return {
    oldRoot: resolvedOldRoot,
    newRoot: resolvedNewRoot,
    folders: nextFolders,
    assets: nextAssets,
    newRecords,
    pathMappings: relinkFolders.map((folder) => ({
      from: folder.path,
      to: folderPathMap.get(pathKey(folder.path, platform)),
    })),
    stats: {
      folders: relinkFolders.length,
      newFolders: newFolderCount,
      reconnectedAssets,
      missingAssets,
      newAssets: newRecords.length,
    },
  };
}
