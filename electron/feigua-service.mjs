import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FEIGUA_SOURCES, normalizeKeywords, normalizeMusicTag, normalizeMusicTagOptions, validateMusicTag, validateCapture, normalizeVideoQueries, normalizeVideoOptions, validateVideoQueries } from './feigua-contract.mjs';

const initial = () => ({ version: 1, keywords: [], videoQueries: [], videoFilterOptions: { categoryPath: [], tagPath: [] }, musicTag: [], musicTagOptions: [], musicTagOptionsLoadedAt: null, musicTagRestricted: false, lastHotspotsScheduleDate: null, latestResults: [], runs: [] });

function recoverLatestResults(runs, cached = []) {
  const found = new Map();
  const candidates = [...runs.flatMap(run => (run.groups || []).map(group => ({ ...group, sourceRunId: run.id }))), ...(Array.isArray(cached) ? cached : [])]
    .filter(group => group.result && Array.isArray(group.result.rows))
    .sort((a, b) => (Date.parse(b.result.collectedAt) || 0) - (Date.parse(a.result.collectedAt) || 0));
  for (const group of candidates) {
    const key = JSON.stringify([group.kind, group.keyword || null]);
    if (!found.has(key)) found.set(key, group);
  }
  return [...found.values()];
}

// Fixed Beijing time, independent of the computer's timezone and DST settings.
export function dueHotspotsDate(now = Date.now()) {
  const beijing = new Date(now + 8 * 60 * 60 * 1000);
  return beijing.getUTCHours() >= 7 ? beijing.toISOString().slice(0, 10) : null;
}

export class FeiguaService {
  constructor({ userDataPath, browser, storage }) {
    this.browser = browser;
    this.data = initial();
    this.auth = { status: 'unknown', message: '登录飞瓜后将自动开始采集' };
    this.autoCollectRequested = false;
    this.loginSequence = 0;
    this.browser.onAuthChange = auth => {
      this.auth = auth;
      if (auth.status !== 'authenticated' || !this.autoCollectRequested) return;
      this.autoCollectRequested = false;
      const sequence = this.loginSequence;
      this.autoStart = Promise.resolve(this.operation).then(() => {
        if (!this.controller && sequence === this.loginSequence) return this.start();
      }).catch(() => { this.auth = { status: 'error', message: '自动采集未能启动，请重试采集' }; });
    };
    this.controller = null;
    this.writeQueue = Promise.resolve();
    this.configQueue = Promise.resolve();
    this.operation = null;
    this.disposed = false;
    this.scheduleTimer = null;
    this.schedulePending = false;
    const filename = path.join(userDataPath, 'feigua-trends', 'state.json');
    this.storage = storage || {
      read: async () => {
        try { return JSON.parse(await readFile(filename, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return initial(); throw new Error('热点数据读取失败，已保留原文件，请检查本机存储'); }
      },
      write: async data => {
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(`${filename}.tmp`, JSON.stringify(data), { mode: 0o600 });
        await rename(`${filename}.tmp`, filename);
      },
    };
    this.ready = this.load();
    this.ready.catch(() => {}); // State calls report initialization errors to the UI.
  }

  async load() {
    const data = await this.storage.read();
    if (data.version !== 1 || !Array.isArray(data.runs)) throw new Error('热点数据格式无法识别，已保留原文件');
    this.data = { version: 1, keywords: normalizeKeywords(data.keywords), musicTag: normalizeMusicTag(data.musicTag),
      videoQueries: normalizeVideoQueries(data.videoQueries ?? normalizeKeywords(data.keywords).map(keyword => ({ keyword }))),
      videoFilterOptions: { categoryPath: normalizeVideoOptions(data.videoFilterOptions?.categoryPath || []), tagPath: normalizeVideoOptions(data.videoFilterOptions?.tagPath || []) },
      musicTagOptions: data.musicTagOptions?.length ? normalizeMusicTagOptions(data.musicTagOptions) : [],
      musicTagRestricted: data.musicTagRestricted === true,
      lastHotspotsScheduleDate: typeof data.lastHotspotsScheduleDate === 'string' ? data.lastHotspotsScheduleDate : null,
      musicTagOptionsLoadedAt: typeof data.musicTagOptionsLoadedAt === 'string' ? data.musicTagOptionsLoadedAt : null,
      latestResults: recoverLatestResults(data.runs, data.latestResults), runs: data.runs.slice(0, 12) };
    this.data.keywords = this.data.videoQueries.map(query => query.keyword);
    let recovered = false;
    for (const run of this.data.runs) {
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.message = '上次采集被中断，已保留完成的组；请重新发起采集';
        for (const group of run.groups) if (['pending', 'running'].includes(group.status)) group.status = 'interrupted';
        recovered = true;
      }
    }
    if (recovered) await this.persist();
  }

  persist() {
    const write = this.writeQueue.then(() => this.storage.write(structuredClone(this.data)));
    this.writeQueue = write.catch(() => {});
    return write;
  }

  async state() {
    await this.ready;
    return structuredClone({ ...this.data, auth: this.auth, busy: Boolean(this.operation || this.controller), scheduleMessage: this.scheduleMessage || null, catalogMessage: this.catalogMessage || null });
  }

  startDailySchedule(canRun) {
    if (this.scheduleTimer || this.disposed) return;
    const tick = () => void this.checkDailySchedule(Date.now(), canRun).catch(() => {
      this.scheduleMessage = '日榜定时采集未能启动，请检查本机存储或手动重试';
    });
    this.scheduleTimer = setInterval(tick, 30_000);
    this.scheduleTimer.unref?.();
    tick();
  }

  async checkDailySchedule(now = Date.now(), canRun = () => false) {
    if (this.disposed || this.schedulePending) return;
    this.schedulePending = true;
    try {
      await this.ready;
      const scheduledDate = dueHotspotsDate(now);
      if (this.disposed || !scheduledDate || this.data.lastHotspotsScheduleDate >= scheduledDate || this.operation || this.controller || !canRun()) return;
      await this.exclusive(async () => {
        if (this.disposed || !canRun()) return;
        await this.launchRun([], [], { onlyHotspots: true, verifyLogin: true, scheduledDate });
        this.scheduleMessage = null;
      });
    } finally { this.schedulePending = false; }
  }

  async exclusive(action) {
    await this.ready;
    if (this.operation || this.controller) throw new Error('正在执行飞瓜操作，请稍后再试');
    this.operation = Promise.resolve().then(action);
    try { return await this.operation; } finally { this.operation = null; }
  }

  async saveKeywords(input) {
    await this.ready;
    const keywords = normalizeKeywords(input);
    const save = this.writeQueue.then(async () => {
      const videoQueries = keywords.map(keyword => this.data.videoQueries.find(query => query.keyword === keyword) || { keyword, categoryPath: [], tagPath: [] });
      await this.storage.write({ ...structuredClone(this.data), keywords, videoQueries });
      this.data.keywords = keywords;
      this.data.videoQueries = videoQueries;
    });
    this.writeQueue = save.catch(() => {});
    this.configQueue = save.catch(() => {});
    await save;
    return this.state();
  }

  async saveVideoQueries(input) {
    await this.ready;
    const videoQueries = validateVideoQueries(input, this.data.videoFilterOptions);
    const keywords = videoQueries.map(query => query.keyword);
    const save = this.writeQueue.then(async () => {
      validateVideoQueries(videoQueries, this.data.videoFilterOptions);
      await this.storage.write({ ...structuredClone(this.data), keywords, videoQueries });
      this.data.keywords = keywords;
      this.data.videoQueries = videoQueries;
    });
    this.writeQueue = save.catch(() => {});
    this.configQueue = save.catch(() => {});
    await save;
    return this.state();
  }

  async saveAndRefreshVideoQueries(input) {
    await this.exclusive(async () => {
      await this.saveVideoQueries(input);
      if (this.data.keywords.length) await this.launchRun([], [...this.data.keywords], { onlyVideos: true, verifyLogin: true });
    });
    return this.state();
  }

  async syncVideoFilters(signal) {
    const catalog = await this.browser.getVideoFilters(signal);
    const videoFilterOptions = { categoryPath: normalizeVideoOptions(catalog.categoryPath), tagPath: normalizeVideoOptions(catalog.tagPath) };
    if (!videoFilterOptions.categoryPath.length || !videoFilterOptions.tagPath.length) throw new Error('视频分类目录为空');
    const save = this.writeQueue.then(async () => {
      await this.storage.write({ ...structuredClone(this.data), videoFilterOptions });
      this.data.videoFilterOptions = videoFilterOptions;
    });
    this.writeQueue = save.catch(() => {});
    await save;
  }

  async login() {
    await this.exclusive(async () => {
      this.autoCollectRequested = true;
      this.loginSequence++;
      try { await this.browser.openLogin(); }
      catch (error) { this.autoCollectRequested = false; throw error; }
    });
    return this.state();
  }

  async saveMusicTag(input) {
    await this.ready;
    const selection = validateMusicTag(input, this.data.musicTagOptions);
    const save = this.writeQueue.then(async () => {
      validateMusicTag(selection, this.data.musicTagOptions);
      await this.storage.write({ ...structuredClone(this.data), musicTag: selection });
      this.data.musicTag = selection;
    });
    this.writeQueue = save.catch(() => {});
    this.configQueue = save.catch(() => {});
    await save;
    return this.state();
  }

  async refreshMusicTags() {
    await this.exclusive(async () => {
      this.auth = await this.browser.checkLogin();
      if (this.auth.status !== 'authenticated') throw new Error('请先登录飞瓜，分类目录会在登录后自动加载');
      await this.syncMusicTags();
    });
    return this.state();
  }

  async saveAndRefreshMusicTag(input) {
    await this.exclusive(async () => {
      await this.saveMusicTag(input);
      await this.launchRun([...this.data.musicTag], [], { onlyRankings: true, verifyLogin: true });
    });
    return this.state();
  }

  async syncMusicTags(signal) {
    const catalog = await this.browser.getMusicTags(signal);
    await this.cacheMusicTags(catalog);
  }

  async cacheMusicTags(catalog) {
    const musicTagOptions = normalizeMusicTagOptions(catalog.options);
    const musicTagRestricted = catalog.restricted === true;
    const loadedAt = new Date().toISOString();
    const save = this.writeQueue.then(async () => {
      await this.storage.write({ ...structuredClone(this.data), musicTagOptions, musicTagOptionsLoadedAt: loadedAt, musicTagRestricted });
      this.data.musicTagOptions = musicTagOptions;
      this.data.musicTagOptionsLoadedAt = loadedAt;
      this.data.musicTagRestricted = musicTagRestricted;
    });
    this.writeQueue = save.catch(() => {});
    await save;
  }

  async checkLogin() {
    await this.exclusive(async () => { this.auth = await this.browser.checkLogin(); });
    return this.state();
  }

  async start() {
    await this.exclusive(async () => {
      await this.configQueue;
      const musicTag = [...this.data.musicTag];
      const keywords = [...this.data.keywords];
      const videoQueries = structuredClone(this.data.videoQueries);
      this.auth = await this.browser.checkLogin();
      if (this.auth.status !== 'authenticated') throw new Error(this.auth.message || '请先登录飞瓜');
      await this.launchRun(musicTag, keywords, { videoQueries });
    });
    return this.state();
  }

  async launchRun(musicTag, keywords, { onlyMusic = false, onlyRankings = false, onlyHotspots = false, onlyVideos = false, verifyLogin = false, scheduledDate = null, videoQueries = this.data.videoQueries } = {}) {
    const groups = (onlyVideos ? [] : onlyMusic ? ['music'] : onlyRankings ? ['music', 'topics'] : onlyHotspots ? ['hotspots'] : ['music', 'topics', 'hotspots']).map(kind => ({ kind, keyword: null, status: 'pending', ...(['music','topics'].includes(kind) ? { musicTag: [...musicTag] } : {}) }));
    groups.push(...keywords.map(keyword => ({ kind: 'videos', keyword, status: 'pending', ...structuredClone(videoQueries.find(query => query.keyword === keyword) || { categoryPath: [], tagPath: [] }) })));
    const run = { id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null, status: 'running', keywords, musicTag, groups, ...(scheduledDate ? { scheduledDate, trigger: 'daily-hotspots' } : {}), message: onlyMusic ? '正在刷新 BGM' : onlyRankings ? '正在刷新 BGM 和话题榜单' : onlyHotspots ? '正在更新每日热点榜' : '准备采集' };
    const previousRuns = this.data.runs;
    const previousScheduleDate = this.data.lastHotspotsScheduleDate;
    if (scheduledDate) this.data.lastHotspotsScheduleDate = scheduledDate;
    this.data.runs = [run, ...previousRuns].slice(0, 12);
    try { await this.persist(); } catch (error) { this.data.runs = previousRuns; this.data.lastHotspotsScheduleDate = previousScheduleDate; throw error; }
    if (this.disposed) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.job = (async () => {
      if (verifyLogin) {
        try {
          this.auth = await this.browser.checkLogin();
          if (this.auth.status !== 'authenticated') throw new Error(onlyHotspots ? '请登录飞瓜后刷新日榜' : '设置已保存，请登录飞瓜后刷新榜单');
        } catch (error) {
          run.status = signal.aborted ? 'cancelled' : 'failed';
          run.finishedAt = new Date().toISOString();
          run.message = onlyHotspots ? '日榜定时采集未完成，请登录飞瓜后手动重试' : '分类榜单刷新未完成';
          for (const group of groups) { group.status = run.status; group.message = signal.aborted ? '已取消' : error.publicMessage || (onlyHotspots ? '飞瓜登录状态未确认，请登录后重试日榜采集' : '设置已保存，飞瓜登录状态未确认，请登录后重试'); }
          await this.persist(); return;
        }
      }
      if (!onlyHotspots) {
        const errors = [];
        if (!onlyVideos && this.browser.getMusicTags && !signal.aborted) {
          try { await this.syncMusicTags(signal); } catch { errors.push('榜单分类自动加载失败'); }
        }
        if (!onlyMusic && !onlyRankings && this.browser.getVideoFilters && !signal.aborted) {
          try { await this.syncVideoFilters(signal); } catch { errors.push('带货视频分类自动加载失败'); }
        }
        this.catalogMessage = errors.length ? `${errors.join('；')}，保留已有目录，请重新登录后重试。` : null;
      }
      await this.execute(run, signal);
    })().catch(() => {
      run.status = 'failed'; run.message = '本机保存失败，已停止采集，请检查存储后重试';
    }).finally(() => { this.controller = null; });
  }

  async execute(run, signal) {
    let stop = false;
    for (const group of run.groups) {
      if (signal.aborted || stop) { group.status = signal.aborted ? 'cancelled' : 'skipped'; continue; }
      group.status = 'running';
      run.message = `正在采集${group.keyword ? `「${group.keyword}」` : FEIGUA_SOURCES[group.kind].label}`;
      await this.persist();
      try {
        const options = { musicTag: group.musicTag || [], categoryPath: group.categoryPath || [], tagPath: group.tagPath || [] };
        const capture = await this.browser.collect(group.kind, group.keyword, signal, options);
        if (signal.aborted) { group.status = 'cancelled'; continue; }
        if (group.kind === 'music' && capture.musicTagOptions?.length) await this.cacheMusicTags({ options: capture.musicTagOptions, restricted: capture.musicTagRestricted });
        group.result = validateCapture(group.kind, group.keyword, capture, options);
        group.status = 'completed';
        this.data.latestResults = recoverLatestResults([{ id: run.id, groups: [group] }], this.data.latestResults);
      } catch (error) {
        group.status = signal.aborted ? 'cancelled' : 'failed';
        // Only adapter-owned messages are exposed, never raw browser/network errors.
        group.message = signal.aborted ? '已取消' : error.publicMessage || '本组采集未通过校验，请打开飞瓜核对页面后重试';
        if (error.code === 'FEIGUA_AUTH_REQUIRED') {
          this.auth = { status: 'expired', message: '飞瓜登录已失效，请重新登录' }; stop = true;
        }
        if (error.code === 'FEIGUA_NOTICE_FAILED') {
          this.auth = { status: 'error', message: error.publicMessage }; stop = true;
        }
      }
      await this.persist();
    }
    const completed = run.groups.filter(group => group.status === 'completed').length;
    run.status = signal.aborted ? 'cancelled' : completed === run.groups.length ? 'completed' : completed ? 'partial' : 'failed';
    run.finishedAt = new Date().toISOString();
    run.message = `${signal.aborted ? '已取消；' : ''}完成 ${completed}/${run.groups.length} 组`;
    await this.persist();
  }

  async cancel() {
    this.autoCollectRequested = false;
    this.loginSequence++;
    this.controller?.abort();
    this.browser.stop?.();
    return this.state();
  }

  dispose() { this.disposed = true; clearInterval(this.scheduleTimer); this.scheduleTimer = null; this.autoCollectRequested = false; this.loginSequence++; this.controller?.abort(); this.browser.dispose?.(); }
}
