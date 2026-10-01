import path from "node:path";

export const PRODUCTION_LICENSE_STORE_ENV = "AI_MEDIA_LIBRARY_USE_PRODUCTION_LICENSE_STORE";
export const TEST_USER_DATA_PATH_ENV = "AI_MEDIA_LIBRARY_TEST_USER_DATA_PATH";

export function licenseUserDataDirectoryName({ appName, isPackaged, environment = process.env }) {
  const useProductionStore = Boolean(isPackaged) || environment?.[PRODUCTION_LICENSE_STORE_ENV] === "true";
  return useProductionStore ? appName : `${appName}-development`;
}

export function licenseUserDataPath({ appDataPath, appName, isPackaged, environment = process.env }) {
  const requested = String(environment?.[TEST_USER_DATA_PATH_ENV] || "").trim();
  if (!isPackaged && requested) {
    if (!path.isAbsolute(requested)) throw new Error(`${TEST_USER_DATA_PATH_ENV} 必须是绝对路径`);
    return path.resolve(requested);
  }
  return path.join(appDataPath, licenseUserDataDirectoryName({ appName, isPackaged, environment }));
}
