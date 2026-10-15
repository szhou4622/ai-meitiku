import { apiTaskSelection, requireCustomerApi } from "./api-usage.mjs";
import { randomUUID, createHash } from 'node:crypto';
import { stat, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createAliyunClient, cloudErrorMessage, validateRegion, downloadAliyunResult } from './aliyun-subtitle-client.mjs';
import { subtitleDisplayText } from './subtitle-display.mjs';

const CONFIG = 'aliyun-subtitle-settings.v1.bin';
const JOBS = 'aliyun-subtitle-jobs.v1.bin';
const running = new Set(['preparing', 'submitting', 'queued', 'processing', 'downloading']);
const pending = new Set(['waiting', 'paused']);
const fingerprint = key => createHash('sha256').update(key || '').digest('hex');

export function subtitleBatchSummary(jobs) {
  const id = jobs.find(job => job.batchId)?.batchId;
  if (!id) return null;
  const items = jobs.filter(job => job.batchId === id);
  const count = statuses => items.filter(job => statuses.includes(job.status)).length;
  return { id, total: items.length, completed: count(['completed']), waiting: count(['waiting']),
    paused: count(['paused']), active: items.filter(job => running.has(job.status)).length,
    failed: count(['failed', 'preflight-error']), attention: count(['unknown', 'query-error', 'download-error']),
    cancelled: count(['cancelled']), message: items.find(job => job.status === 'paused')?.message || '' };
}

export class AliyunSubtitleService {
  constructor({ secureStore, probe, clientFactory = createAliyunClient, download = downloadAliyunResult, interval = 5000, defaultOutputDirectory = '', onChange = () => {}, assertAccess = () => {}, getApiSelection = async () => apiTaskSelection("aliyun"), platformExecute = null, platformUpload = null, platformStatus = null, getPlatformStatus = null, watchBilling = async () => {} }) {
    Object.assign(this, { secureStore, probe, clientFactory, download, interval, defaultOutputDirectory, onChange, assertAccess, getApiSelection, platformExecute, platformUpload, platformStatus, getPlatformStatus, watchBilling });
    this.config = { browserMode: 'system', accessKeyId: '', accessKeySecret: '' };
    this.platformReady = false; this.platformSelected = false;
    this.jobs = []; this.busy = false; this.stopped = false; this.writes = Promise.resolve(); this.stateVersion = 0;
  }
  async initialize() {
    const rawConfig = await this.secureStore.readEncrypted(CONFIG);
    const rawJobs = await this.secureStore.readEncrypted(JOBS);
    if (rawConfig) this.config = { ...this.config, ...JSON.parse(rawConfig) };
    if (rawJobs) {
      const parsed = JSON.parse(rawJobs);
      if (!Array.isArray(parsed)) throw new Error('去字幕任务记录无法读取');
      this.jobs = parsed;
    }
    for (const job of this.jobs) {
      if (job.status === 'submitting') {
        if (job.apiSelection?.apiMode === 'platform_api' && job.jobId) {
          job.status = 'processing'; job.message = '软件已重新打开，正在查询并取回原成片；不会重新提交';
        } else if (job.platformPhase === 'uploading' && !job.jobId) {
          job.status = 'paused'; job.message = '上传时软件退出，本条尚未提交生成或扣分；可继续上传';
        } else { job.status = 'unknown'; job.message = '提交时软件退出，无法确认是否收费。请凭任务时间在云服务核实；不会自动重复提交。'; }
      }
      if (job.status === 'downloading') job.status = 'processing';
      if (job.status === 'waiting' || job.status === 'preparing') {
        job.status = 'paused'; job.message = '软件已重新打开，待提交队列已暂停。点击继续批次后再提交；已有云端任务继续查询。';
      }
    }
    await this.refreshPlatformStatus();
    for (const job of this.jobs) if (job.status === 'failed' && job.billingPending && job.apiSelection?.apiMode === 'platform_api' && job.jobId) await this.watchBilling(job.jobId);
    await this.persist();
    this.schedule();
    return this;
  }
  publicState() {
    const batch = subtitleBatchSummary(this.jobs);
    return { version: ++this.stateVersion, configured: this.platformSelected ? this.platformReady : Boolean(this.config.accessKeyId && this.config.accessKeySecret), apiMode: this.platformSelected ? 'platform_api' : 'customer_api', personalConfigured: Boolean(this.config.accessKeyId && this.config.accessKeySecret), browserMode: this.config.browserMode, defaultOutputDirectory: this.defaultOutputDirectory,
      batch: batch ? { ...batch, message: subtitleDisplayText(batch.message) } : null,
      jobs: this.jobs.map(({ credentialFingerprint, ...job }) => ({ ...job, message: subtitleDisplayText(job.message), region: job.region ? { ...job.region } : undefined, source: job.source ? { ...job.source } : undefined })) };
  }
  persist() {
    const snapshot = JSON.stringify(this.jobs);
    const task = this.writes.then(async () => { await this.secureStore.writeEncrypted(JOBS, snapshot); this.publish(); });
    this.writes = task.catch(() => {});
    return task;
  }
  publish() { try { this.onChange(this.publicState()); } catch { /* UI observers cannot stop the queue. */ } }
  async saveConfig(payload = {}) {
    const mode = payload.browserMode;
    if (!['system', 'embedded'].includes(mode)) throw new Error('请选择系统浏览器或内置浏览器');
    const id = String(payload.accessKeyId || '').trim(), secret = String(payload.accessKeySecret || '').trim();
    if (Boolean(id) !== Boolean(secret)) throw new Error('更新密钥时请同时填写 AccessKey ID 和 Secret；两项留空则保留');
    if (id && (!/^[A-Za-z0-9]{10,128}$/.test(id) || !/^[A-Za-z0-9+/=_-]{10,256}$/.test(secret))) throw new Error('密钥格式不正确，请重新复制完整密钥');
    if (id && (this.busy || this.jobs.some(job => running.has(job.status) || pending.has(job.status)))) throw new Error('仍有去字幕任务运行或等待提交，请完成或取消待处理队列后再更换密钥');
    const config = { ...this.config, browserMode: mode, ...(id ? { accessKeyId: id, accessKeySecret: secret } : {}) };
    await this.secureStore.writeEncrypted(CONFIG, JSON.stringify(config));
    this.config = config;
    this.publish();
    return this.publicState();
  }
  async refreshPlatformStatus() {
    const selection = await this.getApiSelection();
    this.platformSelected = selection.apiMode === 'platform_api';
    this.platformReady = this.platformSelected && Boolean(this.getPlatformStatus && (await this.getPlatformStatus()).ready);
    return this.publicState();
  }
  client(job) {
    if (job?.apiSelection?.apiMode === 'platform_api') {
      if (!this.platformExecute || !this.platformStatus || !this.platformUpload) throw new Error('去字幕积分接口尚未开放');
      return {
        submit: async (filePath, region) => {
          const info = await stat(filePath);
          if (!info.size || info.size > 1024 ** 3) throw new Error('上传文件不能超过阿里云官方上限 1 GB');
          job.platformUploadRequestId ||= `subtitle-upload:${job.id}`;
          job.platformPhase = 'uploading'; job.message = '正在直传视频到云端，上传完成后确认积分报价；上传本身不扣分'; await this.persist();
          let completed;
          try {
            let uploaded;
            if (job.platformUploadId) {
              if (job.platformUploadSize !== info.size || job.platformUploadModifiedAt !== info.mtimeMs)
                throw new Error('原视频已变化，请重新添加视频');
              uploaded = { upload_id: job.platformUploadId };
            } else {
              uploaded = await this.platformUpload(filePath, { requestId: job.platformUploadRequestId, onProgress: async progress => {
                job.uploadedBytes = progress.uploadedBytes; job.uploadTotalBytes = progress.totalBytes;
                job.message = progress.uploadedBytes === progress.totalBytes ? '直传完成，正在验证云端视频；上传本身不扣分'
                  : `视频直传 ${Math.floor(progress.uploadedBytes / progress.totalBytes * 100)}%；上传本身不扣分`;
                await this.persist();
              } });
              job.platformUploadId = uploaded.upload_id; job.platformUploadSize = info.size; job.platformUploadModifiedAt = info.mtimeMs;
              await this.persist(); // Reuse the same uploaded bytes after a lost quote response.
            }
            completed = await this.platformExecute({ feature: 'subtitle-removal', provider: 'aliyun', requestId: `subtitle:${job.id}`,
              payload: { upload_id: uploaded.upload_id, region, consent: true }, onProgress: async body => {
                this.transferProgress(job, body); await this.persist();
              }, onQuoted: async quoteId => {
                job.jobId = quoteId; job.platformPhase = 'quoted';
                job.message = '视频直传并校验完成，等待积分确认或云端处理'; await this.persist();
              } });
          } catch (error) {
            if (!job.jobId && error.code === 'SUBTITLE_UPLOAD_EXPIRED') {
              delete job.platformUploadId;
              job.platformUploadRequestId = `subtitle-upload:${randomUUID()}`;
              await this.persist(); // Only a later explicit resume creates a new upload.
            }
            if (!job.jobId) error.noSupplierCall = true;
            throw error;
          }
          job.platformResult = completed.result; job.billingPending = completed.billingPending === true;
          return completed.quoteId;
        },
        query: async quoteId => {
          const stale = job.refreshPlatformResult || (job.platformResult?.download_expires_at && job.platformResult.download_expires_at * 1000 <= Date.now() + 30000);
          const body = job.platformResult && !stale ? { result: job.platformResult, status: 'awaiting-bill' } : await this.platformStatus(quoteId);
          this.transferProgress(job, body);
          if (['source-expired', 'abandoned'].includes(body.transfer?.phase))
            return { status: 'PROCESS_SUCCESS', result: { download_error: 'SUBTITLE_SOURCE_EXPIRED' } };
          if (body.result) { job.platformResult = body.result; job.refreshPlatformResult = false; }
          if (body.result) return { status: 'PROCESS_SUCCESS', result: body.result };
          if (body.status === 'quoted') return { status: 'AWAITING_CONFIRMATION' };
          if (body.status === 'failed') return { status: 'PROCESS_FAILED', billingPending: body.billing_pending === true, pointsUsed: body.points_used };
          return { status: 'PROCESSING' };
        },
      };
    }
    if (job) requireCustomerApi(job.apiSelection || apiTaskSelection("aliyun"));
    if (!this.config.accessKeyId || !this.config.accessKeySecret) throw new Error('请先在设置中保存云服务密钥');
    if (job && job.credentialFingerprint !== fingerprint(this.config.accessKeyId)) throw new Error('请使用提交此任务时的云服务密钥查询');
    return this.clientFactory({ accessKeyId: this.config.accessKeyId, accessKeySecret: this.config.accessKeySecret });
  }
  transferProgress(job, body) {
    const t = body?.transfer || {};
    job.platformPhase = t.phase || (body?.status === 'quoted' ? 'quoted' : 'processing');
    job.transfer = t;
    const phases = { processing: '云端处理中', retrieving: '处理已完成，服务器正在取回成片',
      verifying: '服务器正在校验成片', storing: '正在转存成片到私有存储', ready: '成片已转存，准备下载',
      'source-expired': '成片取回地址已失效，无法继续下载；不会自动重新处理或扣费', abandoned: '此任务已停止取回' };
    job.message = phases[job.platformPhase] || '云端处理中';
    if (t.total_bytes > 0 && t.phase === 'retrieving') job.message += ` ${Math.floor((t.received_bytes || 0) / t.total_bytes * 100)}%`;
    if (t.last_error && !['source-expired', 'abandoned'].includes(t.phase)) job.message += '；连接中断，服务器将自动重试';
    if (body?.result?.result_retained_until) job.resultRetainedUntil = body.result.result_retained_until;
  }
  async verify() {
    requireCustomerApi(await this.getApiSelection());
    const client = this.client();
    try { await client.verify(); } catch (error) { throw new Error(cloudErrorMessage(error)); }
    return { message: '密钥身份验证通过。服务权限、余额和实际去字幕效果需提交视频验证。' };
  }
  async submit(payload) {
    this.assertAccess();
    if (this.busy || this.jobs.some(job => running.has(job.status) || pending.has(job.status))) throw new Error('请等待当前去字幕任务完成或取消待处理队列后再提交');
    if (payload?.consent !== true) throw new Error('请先确认上传视频至云服务并按量计费');
    this.busy = true;
    try {
      const apiSelection = await this.getApiSelection();
      if (apiSelection.apiMode === "platform_api") { await this.refreshPlatformStatus(); if (!this.platformReady) throw Object.assign(new Error("去字幕积分服务暂不可用"), { code: "PLATFORM_API_UNAVAILABLE" }); } else requireCustomerApi(apiSelection);
      const region = validateRegion(payload.region);
      const source = await this.probe(payload.path);
      const directory = payload.outputDirectory || this.defaultOutputDirectory;
      if (directory && directory === this.defaultOutputDirectory) await mkdir(directory, { recursive: true });
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('请选择有效的成片保存目录');
      await access(directory, constants.W_OK);
      const id = randomUUID();
      const job = { id, apiSelection, name: source.name, sourcePath: source.path, source, region,
        credentialFingerprint: fingerprint(this.config.accessKeyId), createdAt: new Date().toISOString(),
        outputPath: path.join(directory, `${path.basename(source.name, path.extname(source.name))}-去字幕-${id.slice(0, 8)}.mp4`),
        status: 'submitting', message: '上传视频并提交云服务', jobId: '', importedAt: null,
        syncToMediaLibrary: payload.syncToMediaLibrary === true, importError: '' };
      this.jobs.unshift(job);
      try { await this.persist(); } catch {
        this.jobs = this.jobs.filter(item => item.id !== id);
        throw new Error('无法保存任务记录，本次未上传或提交，请检查本机存储');
      } // No paid request if its intent cannot be recorded durably.
      void this.finishSubmit(job, this.client(job));
      return this.publicState();
    } finally { this.busy = false; }
  }
  async startBatch(payload) {
    this.assertAccess();
    if (this.busy || this.jobs.some(job => running.has(job.status) || pending.has(job.status))) throw new Error('请等待当前批次完成，或先取消待处理队列');
    if (payload?.consent !== true) throw new Error('请先确认上传所选视频至云服务并承担处理费用');
    if (!Array.isArray(payload.entries) || !payload.entries.length || payload.entries.length > 200) throw new Error('请选择 1 至 200 个待处理视频');
    this.busy = true;
    try {
      const apiSelection = await this.getApiSelection();
      if (apiSelection.apiMode === "platform_api") { await this.refreshPlatformStatus(); if (!this.platformReady) throw Object.assign(new Error("去字幕积分服务暂不可用"), { code: "PLATFORM_API_UNAVAILABLE" }); } else requireCustomerApi(apiSelection);
      if (apiSelection.apiMode === "customer_api") this.client(); // Reuse saved credentials; never reconnect or overwrite settings per file.
      const directory = payload.outputDirectory || this.defaultOutputDirectory;
      if (directory && directory === this.defaultOutputDirectory) await mkdir(directory, { recursive: true });
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('请选择有效的成片保存目录');
      await access(directory, constants.W_OK);
      const batchId = randomUUID(), seen = new Set(), itemIds = new Set();
      const jobs = payload.entries.map(entry => {
        if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || path.extname(entry.path).toLowerCase() !== '.mp4') throw new Error('请选择本地 MP4 视频');
        const key = process.platform === 'win32' ? path.resolve(entry.path).toLowerCase() : path.resolve(entry.path);
        if (seen.has(key)) throw new Error('本批次包含重复视频，请移除重复条目');
        seen.add(key);
        const itemId = typeof entry.id === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(entry.id) ? entry.id : randomUUID();
        if (itemIds.has(itemId)) throw new Error('视频条目标识重复，请重新添加');
        itemIds.add(itemId);
        const id = randomUUID();
        return { id, apiSelection, batchId, itemId, name: path.basename(entry.path), sourcePath: entry.path, region: { ...validateRegion(entry.region) },
          credentialFingerprint: fingerprint(this.config.accessKeyId), createdAt: new Date().toISOString(),
          outputPath: path.join(directory, `${path.basename(entry.path, path.extname(entry.path))}-去字幕-${id.slice(0, 8)}.mp4`),
          status: 'waiting', message: '等待后台队列提交', jobId: '', importedAt: null,
          syncToMediaLibrary: payload.syncToMediaLibrary === true, importError: '' };
      });
      this.jobs.unshift(...jobs);
      try { await this.persist(); } catch {
        this.jobs = this.jobs.filter(job => job.batchId !== batchId);
        throw new Error('无法保存批次记录，本次未上传或提交，请检查本机存储');
      }
      this.schedule();
      queueMicrotask(() => void this.tick().catch(() => {}));
      return this.publicState();
    } finally { this.busy = false; }
  }
  pauseWaiting(batchId, message) {
    if (!batchId) return;
    for (const job of this.jobs) if (job.batchId === batchId && job.status === 'waiting') {
      job.status = 'paused'; job.message = message;
    }
  }
  async pauseBatch(batchId) {
    const items = this.jobs.filter(job => job.batchId === batchId && (pending.has(job.status) || job.status === 'preparing'));
    if (!items.length) throw new Error('本批次已没有待提交视频，已提交任务会继续处理');
    for (const job of items) { job.status = 'paused'; job.message = '后续提交已暂停；已提交的云端任务继续查询和下载'; }
    await this.persist(); return this.publicState();
  }
  async resumeBatch(batchId) {
    this.assertAccess();
    const items = this.jobs.filter(job => job.batchId === batchId);
    if (!items.some(job => job.status === 'paused')) throw new Error('本批次没有暂停的待提交视频');
    if (items.some(job => ['unknown', 'query-error'].includes(job.status))) throw new Error('请先找回或继续查询本批次异常任务，确认后再继续后续提交');
    for (const job of items.filter(job => job.status === 'paused')) this.client(job);
    const changed = items.filter(job => job.status === 'paused').map(job => ({ job, message: job.message }));
    for (const { job } of changed) { job.status = 'waiting'; job.message = '等待后台队列提交'; }
    try { await this.persist(); } catch (error) {
      for (const { job, message } of changed) { job.status = 'paused'; job.message = message; }
      throw error;
    }
    this.schedule(); queueMicrotask(() => void this.tick().catch(() => {}));
    return this.publicState();
  }
  async cancelPending(batchId) {
    const items = this.jobs.filter(job => job.batchId === batchId && (pending.has(job.status) || job.status === 'preparing'));
    if (!items.length) throw new Error('本批次没有可取消的待提交视频');
    for (const job of items) { job.status = 'cancelled'; job.message = '已取消待提交视频，本条未调用云服务处理接口'; }
    await this.persist(); return this.publicState();
  }
  async startNext() {
    const job = this.jobs.find(item => item.status === 'waiting');
    if (!job || this.busy || this.stopped || this.jobs.some(item => running.has(item.status))) return;
    job.status = 'preparing'; job.message = '正在后台检查视频与字幕区域';
    try {
      this.assertAccess();
      await this.persist();
      let source;
      try { source = await this.probe(job.sourcePath); } catch {
        if (job.status !== 'preparing') return;
        job.status = 'preflight-error'; job.message = '视频读取或格式检查失败，本条未上传。请检查原文件、MP4 格式、大小及分辨率后重新添加。';
        await this.persist(); return;
      }
      if (this.stopped || job.status !== 'preparing') return; // Pause/cancel while probing cannot submit.
      const client = this.client(job);
      job.source = source; job.status = 'submitting'; job.message = '上传视频并提交云服务';
      await this.persist(); // Durable intent always precedes a paid call.
      await this.finishSubmit(job, client);
    } catch (error) {
      if (['preparing', 'submitting'].includes(job.status) && !job.jobId) { job.status = 'paused'; job.message = '本地任务记录或账户检查失败，本条尚未提交，请检查存储及设置后继续'; }
      this.pauseWaiting(job.batchId, '批次已暂停，请检查本机存储及云服务连接后继续');
      if (error?.code === 'PLATFORM_TASK_CANCELLED') {
        job.status = 'cancelled'; job.message = '已取消积分确认，本条未提交云端处理';
      }
      if (error?.code === 'FEATURE_NOT_ENTITLED') {
        job.message = 'VIP权益已失效，本条尚未提交；恢复有效VIP后可继续';
        this.pauseWaiting(job.batchId, job.message);
      }
      await this.persist().catch(() => {});
    }
  }
  async finishSubmit(job, client) {
    // Recheck after probing / durable writes, immediately before a new paid job.
    // Already accepted cloud jobs retain their result and recovery record.
    try { this.assertAccess(); } catch {
      job.status = 'paused'; job.message = 'VIP权益已失效，本条尚未提交；恢复有效VIP后可继续';
      this.pauseWaiting(job.batchId, job.message);
      await this.persist();
      return;
    }
    try {
      job.jobId = await client.submit(job.sourcePath, job.region);
      job.status = 'queued'; job.message = '已提交，等待云端处理';
      await this.persist();
    } catch (error) {
      if (['source-expired', 'abandoned'].includes(job.platformPhase)) {
        job.status = 'download-error'; job.message = '云端成片来源已失效或已停止取回，无法继续下载；不会自动重新生成或扣费';
        this.pauseWaiting(job.batchId, '成片取回失败，后续提交已暂停。'); await this.persist(); return;
      }
      if (error?.code === 'PLATFORM_TASK_CANCELLED') {
        job.status = 'cancelled'; job.message = '已取消积分确认，本条未提交云端处理';
        this.pauseWaiting(job.batchId, '已取消当前积分任务，后续待提交视频已暂停'); await this.persist(); return;
      }
      if (error?.noSupplierCall === true) {
        job.status = 'paused'; job.message = '视频上传或报价未完成，本条尚未提交生成，也未冻结或扣除积分；可继续';
        this.pauseWaiting(job.batchId, '视频上传未完成，后续视频已暂停；本条没有扣积分'); await this.persist(); return;
      }
      if (error?.terminalFailure === true) {
        job.status = 'failed'; job.billingPending = error.billingPending === true;
        job.pointsUsed = error.pointsUsed;
        job.message = job.pointsUsed != null ? `任务处理失败，本次扣除 ${job.pointsUsed} 积分。请保留原任务。`
          : job.billingPending ? '任务处理失败，积分结算待核对；请保留原任务。' : '任务处理失败，请查看积分账单中的结算记录。';
        this.pauseWaiting(job.batchId, '当前任务处理失败，后续待处理视频已暂停。');
        await this.persist(); return;
      }
      // Even a timeout may occur after the server accepted a paid request.
      job.status = job.jobId ? 'query-error' : 'unknown';
      job.message = `${cloudErrorMessage(error, { platform: job.apiSelection?.apiMode === 'platform_api' })}。${job.jobId ? '任务已提交，可继续查询。' : '提交结果未确认，请在云服务核实，勿直接重复提交。'}`;
      this.pauseWaiting(job.batchId, '提交结果未确认，后续视频已暂停。先核实异常任务，避免重复收费。');
      await this.persist().catch(() => {});
    }
    this.schedule();
  }
  schedule() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => {}).finally(() => this.schedule());
    }, this.interval);
    this.timer.unref?.();
  }
  async tick() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const job = this.jobs.find(item => ['queued', 'processing'].includes(item.status) && (!item.downloadRetryAt || item.downloadRetryAt <= Date.now()));
      if (job) await this.refresh(job);
      if (!this.stopped) await this.startNext();
    } finally { this.polling = false; }
  }
  async refresh(job) {
    try {
      const data = await this.client(job).query(job.jobId);
      if (data.status === 'PROCESS_SUCCESS') {
        const result = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
        const url = result?.VideoUrl || result?.videoUrl;
        if (result?.download_error) {
          job.status = 'download-error'; job.message = result.download_error === 'SUBTITLE_SOURCE_EXPIRED' ? '云端成片未能及时取回，来源地址已过期；不会自动重新生成或扣费' : result.download_error === 'SUBTITLE_RESULT_EXPIRED'
            ? '成片暂存已过期。请联系支持核对原任务；不会自动重新生成或重复扣分。'
            : '成片暂时无法下载，请稍后继续下载原任务；不会重复生成或扣分。';
          await this.persist(); return;
        }
        if (!url) throw new Error('missing URL');
        job.status = 'downloading'; job.message = '云端处理完成，正在下载成片';
        await this.persist();
        try {
          const controller = new AbortController(); this.downloadController = controller;
          const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1000);
          try {
            const detail = await this.download(url, job.outputPath, { probe: this.probe, signal: controller.signal,
              expectedSize: result.size_bytes, expectedSha256: result.sha256 });
            Object.assign(job, detail, { status: 'completed', message: '成片已保存，可预览并加入媒体库', completedAt: new Date().toISOString() });
          } finally { clearTimeout(timeout); this.downloadController = null; }
        } catch {
          if (job.apiSelection?.apiMode === 'platform_api' && (job.downloadAttempts || 0) < 3) {
            job.downloadAttempts = (job.downloadAttempts || 0) + 1;
            job.downloadRetryAt = Date.now() + job.downloadAttempts * 5000;
            job.refreshPlatformResult = true; job.status = 'processing';
            job.message = `下载中断，将自动续传（${job.downloadAttempts}/3）`;
            await this.persist(); return;
          }
          job.status = 'download-error'; job.message = job.apiSelection?.apiMode === 'platform_api'
            ? '成片未能下载到本机。可继续下载原任务，下载地址会自动更新；不会重新生成或重复扣分。'
            : '成片未能下载到本机。可重新查询下载（不重新收费提交）；临时结果保留 30 分钟。';
        }
      } else if (['PROCESS_FAILED', 'TIMEOUT_FAILED', 'LIMIT_RETRY_FAILED'].includes(data.status)) {
        job.status = 'failed'; job.billingPending = data.billingPending === true;
        job.pointsUsed = data.pointsUsed;
        job.message = job.pointsUsed != null ? `任务处理失败，本次扣除 ${job.pointsUsed} 积分。请保留原任务。`
          : job.billingPending ? '任务处理失败，积分结算待核对；请保留原任务。' : '任务处理失败，请保留任务编号并联系支持。';
        this.pauseWaiting(job.batchId, '当前任务处理失败，后续待处理视频已暂停。');
      } else if (data.status === 'AWAITING_CONFIRMATION') {
        job.status = 'paused'; job.message = '原任务尚未确认运行，点击继续批次后确认；没有重新提交或扣费';
      } else if (['QUEUING', 'PROCESSING'].includes(data.status)) {
        job.status = data.status === 'QUEUING' ? 'queued' : 'processing';
        job.message = data.status === 'QUEUING' ? '云服务排队中' : job.apiSelection?.apiMode === 'platform_api' ? job.message : '云服务处理中';
      } else throw new Error('unknown status');
    } catch (error) {
      job.status = 'query-error'; job.message = `${cloudErrorMessage(error, { platform: job.apiSelection?.apiMode === 'platform_api' })}。可继续查询原任务，不会重新提交。`;
      this.pauseWaiting(job.batchId, '原任务查询异常，后续提交已暂停。继续查询成功后可继续批次。');
    }
    await this.persist();
  }
  async retry(id) {
    const job = this.jobs.find(item => item.id === id);
    if (!job?.jobId || !['query-error', 'download-error', ...(job.apiSelection?.apiMode === 'platform_api' ? ['completed'] : [])].includes(job.status)) throw new Error('该任务没有可继续查询的云端编号');
    this.client(job);
    if (job.apiSelection?.apiMode === 'platform_api') job.refreshPlatformResult = true;
    job.downloadAttempts = 0; job.downloadRetryAt = 0;
    job.status = 'processing'; job.message = '继续查询原任务';
    await this.persist(); this.schedule(); return this.publicState();
  }
  async recoverJobId(id, jobId) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || job.status !== 'unknown' || !/^[a-zA-Z0-9-]{16,128}$/.test(jobId || '')) throw new Error('请输入云服务提供的任务 RequestId');
    job.jobId = jobId; job.status = 'processing'; job.message = '查询手动找回的任务';
    await this.persist(); this.schedule(); return this.publicState();
  }
  async billingSettled({ quoteId, pointsUsed }) {
    const job = this.jobs.find(item => item.jobId === quoteId && item.apiSelection?.apiMode === 'platform_api' && item.status === 'failed');
    if (!job || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(pointsUsed || '')) return;
    job.billingPending = false; job.pointsUsed = pointsUsed;
    job.message = Number(pointsUsed) === 0 ? '任务处理失败，本次未扣积分，冻结已释放。' : `任务处理失败，本次扣除 ${pointsUsed} 积分。请保留原任务。`;
    await this.persist();
  }
  async markImported(id) {
    const job = this.jobs.find(item => item.id === id);
    if (job?.status !== 'completed') throw new Error('成片尚未完成');
    const previous = { importedAt: job.importedAt, importError: job.importError };
    job.importedAt = job.importedAt || new Date().toISOString(); job.importError = '';
    try { await this.persist(); } catch (error) { Object.assign(job, previous); throw error; }
    return this.publicState();
  }
  async markImportFailed(id) {
    const job = this.jobs.find(item => item.id === id);
    if (job?.status !== 'completed' || job.importedAt) throw new Error('该任务无需重试同步');
    job.importError = '同步媒体库失败，成片已保存在本机，可重试同步';
    await this.persist(); return this.publicState();
  }
  shutdown() { this.stopped = true; clearTimeout(this.timer); this.downloadController?.abort(); }
}
