import { randomUUID, createHash } from 'node:crypto';
import { stat, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createAliyunClient, cloudErrorMessage, validateRegion, downloadAliyunResult } from './aliyun-subtitle-client.mjs';

const CONFIG = 'aliyun-subtitle-settings.v1.bin';
const JOBS = 'aliyun-subtitle-jobs.v1.bin';
const running = new Set(['submitting', 'queued', 'processing', 'downloading']);
const fingerprint = key => createHash('sha256').update(key || '').digest('hex');

export class AliyunSubtitleService {
  constructor({ secureStore, probe, clientFactory = createAliyunClient, download = downloadAliyunResult, interval = 5000, defaultOutputDirectory = '' }) {
    Object.assign(this, { secureStore, probe, clientFactory, download, interval, defaultOutputDirectory });
    this.config = { browserMode: 'system', accessKeyId: '', accessKeySecret: '' };
    this.jobs = []; this.busy = false; this.stopped = false; this.writes = Promise.resolve();
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
      if (job.status === 'submitting') { job.status = 'unknown'; job.message = '提交时软件退出，无法确认是否收费。请凭任务时间在阿里云核实；不会自动重复提交。'; }
      if (job.status === 'downloading') job.status = 'processing';
    }
    await this.persist();
    this.schedule();
    return this;
  }
  publicState() {
    return { configured: Boolean(this.config.accessKeyId && this.config.accessKeySecret), browserMode: this.config.browserMode, defaultOutputDirectory: this.defaultOutputDirectory,
      jobs: this.jobs.map(({ credentialFingerprint, ...job }) => job) };
  }
  persist() {
    const snapshot = JSON.stringify(this.jobs);
    const task = this.writes.then(() => this.secureStore.writeEncrypted(JOBS, snapshot));
    this.writes = task.catch(() => {});
    return task;
  }
  async saveConfig(payload = {}) {
    const mode = payload.browserMode;
    if (!['system', 'embedded'].includes(mode)) throw new Error('请选择系统浏览器或内置浏览器');
    const id = String(payload.accessKeyId || '').trim(), secret = String(payload.accessKeySecret || '').trim();
    if (Boolean(id) !== Boolean(secret)) throw new Error('更新密钥时请同时填写 AccessKey ID 和 Secret；两项留空则保留');
    if (id && (!/^[A-Za-z0-9]{10,128}$/.test(id) || !/^[A-Za-z0-9+/=_-]{10,256}$/.test(secret))) throw new Error('密钥格式不正确，请重新复制完整密钥');
    if (id && (this.busy || this.jobs.some(job => running.has(job.status)))) throw new Error('仍有去字幕任务运行，请完成后再更换密钥');
    const config = { ...this.config, browserMode: mode, ...(id ? { accessKeyId: id, accessKeySecret: secret } : {}) };
    await this.secureStore.writeEncrypted(CONFIG, JSON.stringify(config));
    this.config = config;
    return this.publicState();
  }
  client(job) {
    if (!this.config.accessKeyId || !this.config.accessKeySecret) throw new Error('请先在设置中保存阿里云密钥');
    if (job && job.credentialFingerprint !== fingerprint(this.config.accessKeyId)) throw new Error('请使用提交此任务时的阿里云密钥查询');
    return this.clientFactory({ accessKeyId: this.config.accessKeyId, accessKeySecret: this.config.accessKeySecret });
  }
  async verify() {
    const client = this.client();
    try { await client.verify(); } catch (error) { throw new Error(cloudErrorMessage(error)); }
    return { message: '密钥身份验证通过。服务权限、余额和实际去字幕效果需提交视频验证。' };
  }
  async submit(payload) {
    if (this.busy || this.jobs.some(job => running.has(job.status))) throw new Error('请等待当前去字幕任务完成后再提交');
    if (payload?.consent !== true) throw new Error('请先确认上传视频至阿里云并按量计费');
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
        status: 'submitting', message: '上传视频并提交阿里云', jobId: '', importedAt: null,
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
  async finishSubmit(job, client) {
    try {
      job.jobId = await client.submit(job.sourcePath, job.region);
      job.status = 'queued'; job.message = '已提交，等待云端处理';
      await this.persist();
    } catch (error) {
      // Even a timeout may occur after the server accepted a paid request.
      job.status = job.jobId ? 'query-error' : 'unknown';
      job.message = `${cloudErrorMessage(error)}。${job.jobId ? '任务已提交，可继续查询。' : '提交结果未确认，请在阿里云核实，勿直接重复提交。'}`;
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
        job.status = 'failed'; job.message = `阿里云处理失败（${data.status}），请凭任务编号在官方平台排查。`;
      } else if (['QUEUING', 'PROCESSING'].includes(data.status)) {
        job.status = data.status === 'QUEUING' ? 'queued' : 'processing';
        job.message = data.status === 'QUEUING' ? '阿里云排队中' : '阿里云处理中';
      } else throw new Error('unknown status');
    } catch (error) {
      job.status = 'query-error'; job.message = `${cloudErrorMessage(error)}。可继续查询原任务，不会重新提交。`;
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
    if (!job || job.status !== 'unknown' || !/^[a-zA-Z0-9-]{16,128}$/.test(jobId || '')) throw new Error('请输入阿里云提供的任务 RequestId');
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
