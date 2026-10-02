/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  feigua: {
    state: () => ipcRenderer.invoke("feigua-state"),
    saveKeywords: (keywords) => ipcRenderer.invoke("feigua-save-keywords", keywords),
    saveAndRefreshVideoQueries: (queries) => ipcRenderer.invoke("feigua-save-refresh-video-queries", queries),
    saveMusicTag: (path) => ipcRenderer.invoke("feigua-save-music-tag", path),
    saveAndRefreshMusicTag: (path) => ipcRenderer.invoke("feigua-save-refresh-music-tag", path),
    refreshMusicTags: () => ipcRenderer.invoke("feigua-refresh-music-tags"),
    login: () => ipcRenderer.invoke("feigua-login"),
    checkLogin: () => ipcRenderer.invoke("feigua-check-login"),
    start: () => ipcRenderer.invoke("feigua-start"),
    cancel: () => ipcRenderer.invoke("feigua-cancel"),
  },
  aliyunSubtitle: {
    state: () => ipcRenderer.invoke("aliyun-subtitle-state"),
    save: (payload) => ipcRenderer.invoke("aliyun-subtitle-save", payload),
    verify: () => ipcRenderer.invoke("aliyun-subtitle-verify"),
    open: (page, mode) => ipcRenderer.invoke("aliyun-subtitle-open", page, mode),
    choose: () => ipcRenderer.invoke("aliyun-subtitle-choose"),
    inspect: (filePath) => ipcRenderer.invoke("aliyun-subtitle-inspect", filePath),
    submit: (payload) => ipcRenderer.invoke("aliyun-subtitle-submit", payload),
    retry: (id) => ipcRenderer.invoke("aliyun-subtitle-retry", id),
    recover: (id, jobId) => ipcRenderer.invoke("aliyun-subtitle-recover", id, jobId),
    imported: (id) => ipcRenderer.invoke("aliyun-subtitle-imported", id),
    importFailed: (id) => ipcRenderer.invoke("aliyun-subtitle-import-failed", id),
    preview: (id) => ipcRenderer.invoke("aliyun-subtitle-preview", id),
  },
  licenseBootstrap: () => ipcRenderer.invoke("license-bootstrap"),
  licenseDiagnosticLog: () => ipcRenderer.invoke("license-diagnostic-log"),
  licenseCopyDiagnosticLog: () => ipcRenderer.invoke("license-copy-diagnostic-log"),
  licenseClearDiagnosticLog: () => ipcRenderer.invoke("license-clear-diagnostic-log"),
  licenseOnDiagnosticLogChanged: (callback) => {
    ipcRenderer.removeAllListeners("license-diagnostic-log-changed");
    ipcRenderer.on("license-diagnostic-log-changed", (_event, snapshot) => callback(snapshot));
  },
  licenseMachineCode: () => ipcRenderer.invoke("license-machine-code"),
  licenseMachineIdentity: () => ipcRenderer.invoke("license-machine-identity"),
  licenseIdentityDiagnostics: () => ipcRenderer.invoke("license-identity-diagnostics"),
  licenseCopyIdentityDiagnostics: () => ipcRenderer.invoke("license-copy-identity-diagnostics"),
  licenseCopyMachineCode: () => ipcRenderer.invoke("license-copy-machine-code"),
  licenseRevealActivationCode: () => ipcRenderer.invoke("license-reveal-activation-code"),
  licenseCopyActivationCode: () => ipcRenderer.invoke("license-copy-activation-code"),
  licenseSaveActivationCode: (activationCode) => ipcRenderer.invoke("license-save-activation-code", activationCode),
  licenseRepairIdentity: (activationCode) => ipcRenderer.invoke("license-repair-identity", activationCode),
  licenseActivate: (activationCode) => ipcRenderer.invoke("license-activate", activationCode),
  licenseRenewTime: (activationCode) => ipcRenderer.invoke("license-renew-time", activationCode),
  licenseRedeemTime: (activationCode) => ipcRenderer.invoke("license-redeem-time", activationCode),
  licenseRefresh: (options) => ipcRenderer.invoke("license-refresh", options),
  licenseUnbind: () => ipcRenderer.invoke("license-unbind"),
  licenseOnStateChanged: (callback) => {
    ipcRenderer.removeAllListeners("license-state-changed");
    ipcRenderer.on("license-state-changed", (_event, state) => callback(state));
  },
  updateBootstrap: () => ipcRenderer.invoke("update-bootstrap"),
  updateCheck: () => ipcRenderer.invoke("update-check"),
  updateDownload: () => ipcRenderer.invoke("update-download"),
  updateCancelDownload: () => ipcRenderer.invoke("update-cancel-download"),
  updateRemindLater: () => ipcRenderer.invoke("update-remind-later"),
  updateInstallNow: () => ipcRenderer.invoke("update-install-now"),
  updateInstallOnQuit: () => ipcRenderer.invoke("update-install-on-quit"),
  updateExit: () => ipcRenderer.invoke("update-exit"),
  updateOnStateChanged: (callback) => {
    ipcRenderer.removeAllListeners("update-state-changed");
    ipcRenderer.on("update-state-changed", (_event, state) => callback(state));
  },
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  mediaChooseFiles: (options) => ipcRenderer.invoke("media-choose-files", options),
  mediaChooseFolder: () => ipcRenderer.invoke("media-choose-folder"),
  mediaRelinkFolder: (oldRoot, folders, assets) => ipcRenderer.invoke("media-relink-folder", oldRoot, folders, assets),
  mediaPathForFile: (file) => webUtils.getPathForFile(file),
  mediaImportPaths: (paths) => ipcRenderer.invoke("media-import-paths", paths),
  mediaImportClassifierOutput: (outputRoot, outputFiles) => ipcRenderer.invoke("media-import-classifier-output", outputRoot, outputFiles),
  mediaImportClassifierSegments: (segmentDirectory) => ipcRenderer.invoke("media-import-classifier-segments", segmentDirectory),
  mediaStartDrag: (paths) => ipcRenderer.send("media-start-drag", paths),
  mediaScanFolder: (folderPath) => ipcRenderer.invoke("media-scan-folder", folderPath),
  mediaLoadLibrary: () => ipcRenderer.invoke("media-load-library"),
  mediaSaveLibrary: (assets, folders) => ipcRenderer.invoke("media-save-library", assets, folders),
  mediaRevealFile: (targetPath) => ipcRenderer.invoke("media-reveal-file", targetPath),
  mediaTrashFolder: (folderPath) => ipcRenderer.invoke("media-trash-folder", folderPath),
  qianchuanBootstrap: () => ipcRenderer.invoke("qianchuan-bootstrap"),
  qianchuanConfigStatus: () => ipcRenderer.invoke("qianchuan-config-status"),
  qianchuanConfigSave: (payload) => ipcRenderer.invoke("qianchuan-config-save", payload),
  qianchuanConfigConfirmCallback: () => ipcRenderer.invoke("qianchuan-config-confirm-callback"),
  qianchuanConfigTest: () => ipcRenderer.invoke("qianchuan-config-test"),
  qianchuanOpenDeveloperPortal: (browserMode) => ipcRenderer.invoke("qianchuan-open-developer-portal", browserMode),
  qianchuanOAuthStart: (browserMode) => ipcRenderer.invoke("qianchuan-oauth-start", browserMode),
  qianchuanOAuthReopen: (flowId, browserMode) => ipcRenderer.invoke("qianchuan-oauth-reopen", flowId, browserMode),
  qianchuanOAuthPoll: (flowId) => ipcRenderer.invoke("qianchuan-oauth-poll", flowId),
  qianchuanOAuthRevoke: (authorizationId) => ipcRenderer.invoke("qianchuan-oauth-revoke", authorizationId),
  qianchuanVideos: (payload) => ipcRenderer.invoke("qianchuan-videos", payload),
  qianchuanResolve: (payload) => ipcRenderer.invoke("qianchuan-resolve", payload),
  qianchuanPreview: (payload) => ipcRenderer.invoke("qianchuan-preview", payload),
  qianchuanReport: (payload) => ipcRenderer.invoke("qianchuan-report", payload),
  qianchuanTop: (payload) => ipcRenderer.invoke("qianchuan-top", payload),
  qianchuanLibraryCache: (payload) => ipcRenderer.invoke("qianchuan-library-cache", payload),
  qianchuanLibrarySync: (payload) => ipcRenderer.invoke("qianchuan-library-sync", payload),
  qianchuanLibraryCancel: () => ipcRenderer.invoke("qianchuan-library-cancel"),
  qianchuanLibraryOnProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("qianchuan-library-sync-progress", listener);
    return () => ipcRenderer.removeListener("qianchuan-library-sync-progress", listener);
  },
  qianchuanImport: (payload) => ipcRenderer.invoke("qianchuan-import", payload),
  viralCopyList: () => ipcRenderer.invoke("viral-copy-list"),
  viralCopyCapabilities: () => ipcRenderer.invoke("viral-copy-capabilities"),
  viralCopyParse: (text) => ipcRenderer.invoke("viral-copy-parse", text),
  viralCopySave: (payload) => ipcRenderer.invoke("viral-copy-save", payload),
  viralCopyTranscribe: (assetId) => ipcRenderer.invoke("viral-copy-transcribe", assetId),
  viralCopySaveReference: (payload) => ipcRenderer.invoke("viral-copy-save-reference", payload),
  viralCopyDeleteSegments: (targets) => ipcRenderer.invoke("viral-copy-delete-segments", targets),
  viralCopySetConfirmed: (targets, confirmed) => ipcRenderer.invoke("viral-copy-set-confirmed", targets, confirmed),
  viralCopyUpdateText: (target, text) => ipcRenderer.invoke("viral-copy-update-text", target, text),
  viralCopyLinkVisual: (target, assetId) => ipcRenderer.invoke("viral-copy-link-visual", target, assetId),
  viralCopyTranscribeMedia: (payload) => ipcRenderer.invoke("viral-copy-transcribe-media", payload),
  viralLibraryImportCsv: (payload) => ipcRenderer.invoke("viral-library-import-csv", payload),
  viralLibraryAuthorizeWrite: () => ipcRenderer.invoke("viral-library-authorize-write"),
  viralLibraryClassifyVisuals: (records) => ipcRenderer.invoke("viral-library-classify-visuals", records),
  viralLibraryOnClassificationProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("viral-visual-classification-progress", listener);
    return () => ipcRenderer.removeListener("viral-visual-classification-progress", listener);
  },
  viralLibraryDataCsv: (payload) => ipcRenderer.invoke("viral-library-data-csv", payload),
  classifierPreviewMedia: (paths) => ipcRenderer.invoke("classifier-preview-media", paths),
  classifierValidateOutputDirectory: (outputRoot) => ipcRenderer.invoke("classifier-validate-output-directory", outputRoot),
  videoDownloadBootstrap: () => ipcRenderer.invoke("video-download-bootstrap"),
  videoDownloadImportSpreadsheet: () => ipcRenderer.invoke("video-download-import-spreadsheet"),
  videoDownloadEnqueue: (payload) => ipcRenderer.invoke("video-download-enqueue", payload),
  videoDownloadRetry: (taskId) => ipcRenderer.invoke("video-download-retry", taskId),
  videoDownloadCancel: (taskId) => ipcRenderer.invoke("video-download-cancel", taskId),
  videoDownloadPause: (paused) => ipcRenderer.invoke("video-download-pause", paused),
  videoDownloadClearCompleted: () => ipcRenderer.invoke("video-download-clear-completed"),
  videoDownloadSetOutput: (directory) => ipcRenderer.invoke("video-download-set-output", directory),
  videoDownloadMarkImported: (taskId) => ipcRenderer.invoke("video-download-mark-imported", taskId),
  videoDownloadAuthBootstrap: () => ipcRenderer.invoke("video-download-auth-bootstrap"),
  videoDownloadAuthOpen: (platform) => ipcRenderer.invoke("video-download-auth-open", platform),
  videoDownloadAuthRefresh: () => ipcRenderer.invoke("video-download-auth-refresh"),
  videoDownloadAuthOnStateChanged: (callback) => {
    ipcRenderer.removeAllListeners("video-download-auth-state-changed");
    ipcRenderer.on("video-download-auth-state-changed", (_event, state) => callback(state));
  },
  videoDownloadOnStateChanged: (callback) => {
    ipcRenderer.removeAllListeners("video-download-state-changed");
    ipcRenderer.on("video-download-state-changed", (_event, state) => callback(state));
  },
  classifierPrepareInput: (paths) => ipcRenderer.invoke("classifier-prepare-input", paths),
  classifierBootstrap: () => ipcRenderer.invoke("classifier-bootstrap"),
  classifierMarkOutputSynced: (jobId) => ipcRenderer.invoke("classifier-mark-output-synced", jobId),
  classifierSetActive: (templateId) => ipcRenderer.invoke("classifier-set-active", templateId),
  classifierSaveConfig: (payload) => ipcRenderer.invoke("classifier-save-config", payload),
  apiSettingsGet: () => ipcRenderer.invoke("api-settings-get"),
  apiSettingsSave: (payload) => ipcRenderer.invoke("api-settings-save", payload),
  apiSettingsTest: (kind, payload) => ipcRenderer.invoke("api-settings-test", kind, payload),
  storageManagementGet: () => ipcRenderer.invoke("storage-management-get"),
  storageManagementSave: (settings) => ipcRenderer.invoke("storage-management-save", settings),
  storageManagementClear: (category) => ipcRenderer.invoke("storage-management-clear", category),
  classifierCreateTemplate: (payload) => ipcRenderer.invoke("classifier-create-template", payload),
  classifierEditTemplate: (payload) => ipcRenderer.invoke("classifier-edit-template", payload),
  classifierGenerateTemplateDraft: (productBrief) => ipcRenderer.invoke("classifier-generate-template-draft", productBrief),
  classifierDraftOnProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("classifier-draft-progress", listener);
    return () => ipcRenderer.removeListener("classifier-draft-progress", listener);
  },
  classifierImportProductInfoFiles: () => ipcRenderer.invoke("classifier-import-product-info-files"),
  classifierImportProductInfoPaths: (filePaths) => ipcRenderer.invoke("classifier-import-product-info-paths", filePaths),
  classifierRecognizeScannedProductInfo: (filePaths) => ipcRenderer.invoke("classifier-recognize-scanned-product-info", filePaths),
  classifierImportTemplate: () => ipcRenderer.invoke("classifier-import-template"),
  classifierExportTemplate: (templateId) => ipcRenderer.invoke("classifier-export-template", templateId),
  classifierRun: (payload) => ipcRenderer.invoke("classifier-run", payload),
  classifierCancel: () => ipcRenderer.invoke("classifier-cancel"),
  classifierOnProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("classifier-progress", listener);
    return () => ipcRenderer.removeListener("classifier-progress", listener);
  },
  openLocalPath: (targetPath) => ipcRenderer.invoke("open-local-path", targetPath),
  openProductGuide: () => ipcRenderer.invoke("open-product-guide"),
  openClassifierRules: () => ipcRenderer.invoke("open-classifier-rules"),
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron-app", `platform-${process.platform}`);
});
