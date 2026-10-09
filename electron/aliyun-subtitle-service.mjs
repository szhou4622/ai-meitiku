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
  constructor({ secureStore, probe, clientFactory = createAliyunClient, download = downloadAliyunResult, interval = 5000, defaultOutputDirectory = '', onChange = () => {}, assertAccess = () => {} }) {
    Object.assign(this, { secureStore, probe, clientFactory, download, interval, defaultOutputDirectory, onChange, assertAccess });
    this.config = { browserMode: 'system', accessKeyId: '', accessKeySecret: '' };
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
      if (job.status === 'submitting') { job.status = 'unknown'; job.message = '提交时软件退出，无法确认是否收费。请凭任务时间在云服务核实；不会自动重复提交。'; }
      if (job.status === 'downloading') job.status = 'processing';
      if (job.status === 'waiting' || job.status === 'preparing') {
        job.status = 'paused'; job.message = '软件已重新打开，待提交队列已暂停。点击继续批次后再提交；已有云端任务继续查询。';
      }
    }
    await this.persist();
    this.schedule();
    return this;
  }
  publicState() {
    const batch = subtitleBatchSummary(this.jobs);
    return { version: ++this.stateVersion, configured: Boolean(this.config.accessKeyId && this.config.accessKeySecret), browserMode: this.config.browserMode, defaultOutputDirectory: this.defaultOutputDirectory,
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
  client(job) {
    if (!this.config.accessKeyId || !this.config.accessKeySecret) throw new Error('请先在设置中保存云服务密钥');
    if (job && job.credentialFingerprint !== fingerprint(this.config.accessKeyId)) throw new Error('请使用提交此任务时的云服务密钥查询');
    return this.clientFactory({ accessKeyId: this.config.accessKeyId, accessKeySecret: this.config.accessKeySecret });
  }
  async verify() {
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
      const client = this.client();
      const region = validateRegion(payload.region);
      const source = await this.probe(payload.path);
      const directory = payload.outputDirectory || this.defaultOutputDirectory;
      if (directory && directory === this.defaultOutputDirectory) await mkdir(directory, { recursive: true });
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('请选择有效的成片保存目录');
      await access(directory, constants.W_OK);
      const id = randomUUID();
      const job = { id, name: source.name, sourcePath: source.path, source, region,
        credentialFingerprint: fingerprint(this.config.accessKeyId), createdAt: new Date().toISOString(),
        outputPath: path.join(directory, `${path.basename(source.name, path.extname(source.name))}-去字幕-${id.slice(0, 8)}.mp4`),
        status: 'submitting', message: '上传视频并提交云服务', jobId: '', importedAt: null,
        syncToMediaLibrary: payload.syncToMediaLibrary === true, importError: '' };
      this.jobs.unshift(job);
      try { await this.persist(); } catch {
        this.jobs = this.jobs.filter(item => item.id !== id);
        throw new Error('无法保存任务记录，本次未上传或提交，请检查本机存储');
      } // No paid request if its intent cannot be recorded durably.
      void this.finishSubmit(job, client);
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
      this.client(); // Reuse saved credentials; never reconnect or overwrite settings per file.
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
        return { id, batchId, itemId, name: path.basename(entry.path), sourcePath: entry.path, region: { ...validateRegion(entry.region) },
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
      // Even a timeout may occur after the server accepted a paid request.
      job.status = job.jobId ? 'query-error' : 'unknown';
      job.message = `${cloudErrorMessage(error)}。${job.jobId ? '任务已提交，可继续查询。' : '提交结果未确认，请在云服务核实，勿直接重复提交。'}`;
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
      const job = this.jobs.find(item => ['queued', 'processing'].includes(item.status));
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
        if (!url) throw new Error('missing URL');
        job.status = 'downloading'; job.message = '云端处理完成，正在下载成片';
        await this.persist();
        try {
          const controller = new AbortController(); this.downloadController = controller;
          const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1000);
          try {
            const detail = await this.download(url, job.outputPath, { probe: this.probe, signal: controller.signal });
            Object.assign(job, detail, { status: 'completed', message: '成片已保存，可预览并加入媒体库', completedAt: new Date().toISOString() });
          } finally { clearTimeout(timeout); this.downloadController = null; }
        } catch {
          job.status = 'download-error'; job.message = '成片未能下载到本机。可重新查询下载（不重新收费提交）；临时结果保留 30 分钟。';
        }
      } else if (['PROCESS_FAILED', 'TIMEOUT_FAILED', 'LIMIT_RETRY_FAILED'].includes(data.status)) {
        job.status = 'failed'; job.message = `云服务处理失败（${data.status}），请凭任务编号在官方平台排查。`;
      } else if (['QUEUING', 'PROCESSING'].includes(data.status)) {
        job.status = data.status === 'QUEUING' ? 'queued' : 'processing';
        job.message = data.status === 'QUEUING' ? '云服务排队中' : '云服务处理中';
      } else throw new Error('unknown status');
    } catch (error) {
      job.status = 'query-error'; job.message = `${cloudErrorMessage(error)}。可继续查询原任务，不会重新提交。`;
      this.pauseWaiting(job.batchId, '原任务查询异常，后续提交已暂停。继续查询成功后可继续批次。');
    }
    await this.persist();
  }
  async retry(id) {
    const job = this.jobs.find(item => item.id === id);
    if (!job?.jobId || !['query-error', 'download-error'].includes(job.status)) throw new Error('该任务没有可继续查询的云端编号');
    this.client(job);
    job.status = 'processing'; job.message = '继续查询原任务';
    await this.persist(); this.schedule(); return this.publicState();
  }
  async recoverJobId(id, jobId) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || job.status !== 'unknown' || !/^[a-zA-Z0-9-]{16,128}$/.test(jobId || '')) throw new Error('请输入云服务提供的任务 RequestId');
    job.jobId = jobId; job.status = 'processing'; job.message = '查询手动找回的任务';
    await this.persist(); this.schedule(); return this.publicState();
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
