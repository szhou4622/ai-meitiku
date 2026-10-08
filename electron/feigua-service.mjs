import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeLoginEntryUrl, normalizeWorkspaceHint } from './feigua-login-entry.mjs';
import { recoverVideoHistory, videoCollectionWeek } from './feigua-video-history.mjs';
import { pendingTopicCheck, settledTopicPeriod } from './feigua-topic-schedule.mjs';
import { pendingMusicCheck } from './feigua-music-schedule.mjs';
import { retainProductFields, restoreProductFieldsInState } from './feigua-product-cache.mjs';
import builtInVideoFilters from './feigua-video-catalog.json' with { type: 'json' };
import { FEIGUA_SOURCES, normalizeKeywords, normalizeMusicTag, normalizeMusicTagOptions, validateMusicTag, validateCapture, normalizeVideoQueries, normalizeVideoOptions, validateVideoQueries } from './feigua-contract.mjs';

const videoFilterDefaults = (cached) => ({
  categoryPath: normalizeVideoOptions(cached?.categoryPath?.length ? cached.categoryPath : builtInVideoFilters.categoryPath),
  tagPath: normalizeVideoOptions(cached?.tagPath?.length ? cached.tagPath : builtInVideoFilters.tagPath),
});
const initial = () => ({ version: 1, loginEntryUrl: '', keywords: [], videoQueries: [], videoFilterOptions: videoFilterDefaults(), musicTag: [], musicTagOptions: [], musicTagOptionsLoadedAt: null, musicTagRestricted: false, lastHotspotsScheduleDate: null, lastVideosScheduleDate: null, latestResults: [], runs: [] });

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

export function dueVideosDate(now = Date.now()) {
  const beijing = new Date(now + 8 * 60 * 60 * 1000);
  if (beijing.getUTCDay() === 1 && beijing.getUTCHours() * 60 + beijing.getUTCMinutes() < 390) return null;
  return videoCollectionWeek(new Date(now).toISOString());
}

export class FeiguaService {
  constructor({ userDataPath, browser, storage, retryWait = (ms, signal) => delay(ms, undefined, { signal }) }) {
    this.browser = browser;
    this.retryWait = retryWait;
    this.browser.onWorkspaceVerified = hint => this.saveWorkspaceHint(hint);
    this.browser.onVideoDetailProgress = ({ index, total }) => {
      const run = this.data.runs[0];
      if (this.controller && run?.status === 'running') run.message = `已取得视频榜单，正在核验补充信息（${index}/${total} 条）`;
    };
    this.data = initial();
    this.auth = { status: 'unknown', message: '登录飞瓜后将自动开始采集' };
    this.autoCollectRequested = false;
    this.autoCatalogRequested = false;
    this.loginSequence = 0;
    this.browser.onAuthChange = auth => {
      this.auth = auth;
      if (auth.status !== 'authenticated' || !this.autoCollectRequested && !this.autoCatalogRequested) return;
      const collectAfterLogin = this.autoCollectRequested;
      this.autoCollectRequested = false;
      this.autoCatalogRequested = false;
      const sequence = this.loginSequence;
      this.autoStart = Promise.resolve(this.operation).then(() => {
        if (!this.controller && sequence === this.loginSequence) return collectAfterLogin ? this.start({ trigger: 'login' }) : this.prepareCatalogs();
      }).catch(() => { if (sequence === this.loginSequence && !this.disposed) this.auth = { status: 'error', message: '自动采集未能启动，请重试采集' }; });
    };
    this.controller = null;
    this.writeQueue = Promise.resolve();
    this.configQueue = Promise.resolve();
    this.operation = null;
    this.operationSequence = null;
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
    const stored = await this.storage.read();
    if (stored.version !== 1 || !Array.isArray(stored.runs)) throw new Error('热点数据格式无法识别，已保留原文件');
    const { data, changed: fieldsRestored } = restoreProductFieldsInState(stored);
    this.data = { version: 1, loginEntryUrl: normalizeLoginEntryUrl(data.loginEntryUrl ?? ''), keywords: normalizeKeywords(data.keywords), musicTag: normalizeMusicTag(data.musicTag),
      videoQueries: normalizeVideoQueries(data.videoQueries ?? normalizeKeywords(data.keywords).map(keyword => ({ keyword }))),
      videoFilterOptions: videoFilterDefaults(data.videoFilterOptions),
      musicTagOptions: data.musicTagOptions?.length ? normalizeMusicTagOptions(data.musicTagOptions) : [],
      musicTagRestricted: data.musicTagRestricted === true,
      lastHotspotsScheduleDate: typeof data.lastHotspotsScheduleDate === 'string' ? data.lastHotspotsScheduleDate : null,
      lastVideosScheduleDate: typeof data.lastVideosScheduleDate === 'string' ? videoCollectionWeek(`${data.lastVideosScheduleDate}T04:00:00Z`) : null,
      lastTopicsCheck: data.lastTopicsCheck && /^\d{4}-\d{2}-\d{2}$/.test(data.lastTopicsCheck.slot) && typeof data.lastTopicsCheck.expectedPeriod === 'string'
        ? { slot: data.lastTopicsCheck.slot, expectedPeriod: data.lastTopicsCheck.expectedPeriod, checkedAt: data.lastTopicsCheck.checkedAt, musicTag: normalizeMusicTag(data.lastTopicsCheck.musicTag) } : null,
      lastMusicCheck: data.lastMusicCheck && /^\d{4}-\d{2}-\d{2}$/.test(data.lastMusicCheck.date)
        ? { date: data.lastMusicCheck.date, checkedAt: data.lastMusicCheck.checkedAt, musicTag: normalizeMusicTag(data.lastMusicCheck.musicTag) } : null,
      musicTagOptionsLoadedAt: typeof data.musicTagOptionsLoadedAt === 'string' ? data.musicTagOptionsLoadedAt : null,
      latestResults: recoverLatestResults(data.runs, data.latestResults),
      videoHistory: recoverVideoHistory(data.runs, data.latestResults || [], Array.isArray(data.videoHistory) ? data.videoHistory : []), runs: data.runs.slice(0, 12) };
    this.data.keywords = this.data.videoQueries.map(query => query.keyword);
    this.browser.setLoginEntryUrl?.(this.data.loginEntryUrl);
    // Upgrade existing API results into an untrusted reload hint once. An
    // explicit null (e.g. after editing the entry) must never resurrect it.
    let hint = data.workspaceHint;
    if (!Object.hasOwn(data, 'workspaceHint')) {
      const result = this.data.latestResults.find(group => group.result?.provenance?.transport === 'provider-api' && group.result.provenance.responseCode === 200)?.result;
      try {
        const source = new URL(result?.sourceUrl);
        if (source.pathname.startsWith('/app/')) hint = { entryUrl: this.data.loginEntryUrl, origin: source.origin };
      } catch { /* No previously verified provider result. */ }
    }
    this.data.workspaceHint = normalizeWorkspaceHint(hint, this.data.loginEntryUrl);
    this.browser.setWorkspaceHint?.(this.data.workspaceHint);
    if (!this.data.loginEntryUrl) this.auth = { status: 'signed_out', message: '请先配置并保存登录入口网址' };
    let recovered = fieldsRestored;
    for (const run of this.data.runs) {
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.message = '上次采集被中断，已保留完成的组；请重新发起采集';
        for (const group of run.groups) if (['pending', 'running', 'retrying'].includes(group.status)) { group.status = 'interrupted'; group.retryDelay = null; }
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

  async saveWorkspaceHint(input) {
    const save = this.writeQueue.then(async () => {
      const workspaceHint = normalizeWorkspaceHint(input, this.data.loginEntryUrl);
      if (!workspaceHint) throw new Error('工作台复查地址与当前登录入口不一致');
      await this.storage.write({ ...structuredClone(this.data), workspaceHint });
      this.data.workspaceHint = workspaceHint;
    });
    this.writeQueue = save.catch(() => {});
    await save;
  }

  async state() {
    await this.ready;
    return structuredClone({ ...this.data, auth: this.auth, busy: Boolean(this.operation || this.controller), credentialMessage: this.browser.credentialMessage || null, storageMessage: this.storageMessage || null, scheduleMessage: this.scheduleMessage || null, catalogMessage: this.catalogMessage || null });
  }

  startDailySchedule(canRun) {
    if (this.scheduleTimer || this.disposed) return;
    const tick = () => void this.checkDailySchedule(Date.now(), canRun).catch(() => {
      this.scheduleMessage = '定时采集未能启动，请检查本机存储或手动重试';
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
      if (this.disposed || this.operation || this.controller || !canRun()) return;
      await this.exclusive(async () => {
        await this.configQueue;
        if (this.disposed || !canRun()) return;
        const videosDate = dueVideosDate(now);
        const hotspotsDate = dueHotspotsDate(now);
        const topicCheck = pendingTopicCheck(this.data, now);
        const musicCheck = pendingMusicCheck(this.data, now);
        // One browser session: catch up the earlier video task first, then the
        // next timer tick starts hotspots once the session is idle.
        if (videosDate && (!this.data.lastVideosScheduleDate || this.data.lastVideosScheduleDate < videosDate) && this.data.videoQueries.length) {
          await this.launchRun([], [...this.data.keywords], { onlyVideos: true, verifyLogin: true, scheduledDate: videosDate });
        } else if (hotspotsDate && (!this.data.lastHotspotsScheduleDate || this.data.lastHotspotsScheduleDate < hotspotsDate)) {
          await this.launchRun([], [], { onlyHotspots: true, verifyLogin: true, scheduledDate: hotspotsDate });
        } else if (musicCheck) {
          await this.launchRun(musicCheck.musicTag, [], { onlyMusic: true, verifyLogin: true, musicCheck });
        } else if (topicCheck) {
          await this.launchRun(topicCheck.musicTag, [], { onlyTopics: true, verifyLogin: true, topicCheck });
        } else return;
        this.scheduleMessage = null;
      });
    } finally { this.schedulePending = false; }
  }

  async exclusive(action) {
    const sequence = this.loginSequence;
    await this.ready;
    if (this.operation || this.controller) throw new Error('正在执行飞瓜操作，请稍后再试');
    if (this.disposed || sequence !== this.loginSequence) return;
    this.operationSequence = sequence;
    this.operation = Promise.resolve().then(action);
    try { return await this.operation; } finally { this.operation = null; this.operationSequence = null; }
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

  async saveAndRefreshVideoQueries(input, { changedOnly = false } = {}) {
    await this.exclusive(async () => {
      await this.configQueue;
      const previous = new Map(this.data.videoQueries.map(query => [query.keyword, JSON.stringify(query)]));
      await this.saveVideoQueries(input);
      const queries = changedOnly ? this.data.videoQueries.filter(query => previous.get(query.keyword) !== JSON.stringify(query)) : this.data.videoQueries;
      if (queries.length) await this.launchRun([], queries.map(query => query.keyword), { onlyVideos: true, verifyLogin: true, videoQueries: structuredClone(queries), trigger: changedOnly ? 'video-settings' : 'manual-videos' });
    });
    return this.state();
  }

  async syncVideoFilters(signal) {
    return this.cacheVideoFilters(await this.browser.getVideoFilters(signal));
  }

  async cacheVideoFilters(catalog) {
    const videoFilterOptions = { categoryPath: normalizeVideoOptions(catalog.categoryPath), tagPath: normalizeVideoOptions(catalog.tagPath) };
    if (!videoFilterOptions.categoryPath.length || !videoFilterOptions.tagPath.length) throw new Error('视频分类目录为空');
    const save = this.writeQueue.then(async () => {
      await this.storage.write({ ...structuredClone(this.data), videoFilterOptions });
      this.data.videoFilterOptions = videoFilterOptions;
    });
    this.writeQueue = save.catch(() => {});
    await save;
  }

  async prepareCatalogs() {
    await this.exclusive(async () => {
      this.auth = await this.browser.checkLogin();
      if (this.auth.status !== 'authenticated') throw new Error('请先登录飞瓜');
      const errors = [];
      try { await this.syncMusicTags(); } catch (error) { if (error.code === 'FEIGUA_VERIFICATION_REQUIRED') throw error; errors.push('榜单分类'); }
      try { await this.syncVideoFilters(); } catch (error) { if (error.code === 'FEIGUA_VERIFICATION_REQUIRED') throw error; errors.push('视频分类'); }
      this.catalogMessage = errors.length ? `${errors.join('、')}更新暂未完成，仍可使用已有分类；采集时将核验实际筛选。` : null;
    });
    return this.state();
  }

  async saveLoginEntryUrl(input) {
    const loginEntryUrl = normalizeLoginEntryUrl(input);
    await this.exclusive(async () => {
      await this.configQueue;
      if (loginEntryUrl === this.data.loginEntryUrl) return;
      const save = this.writeQueue.then(async () => {
        await this.storage.write({ ...structuredClone(this.data), loginEntryUrl, workspaceHint: null });
        this.data.loginEntryUrl = loginEntryUrl;
        this.data.workspaceHint = null;
      });
      this.writeQueue = save.catch(() => {});
      this.configQueue = save.catch(() => {});
      await save;
      this.autoCollectRequested = false;
      this.autoCatalogRequested = false;
      this.loginSequence++;
      this.browser.setLoginEntryUrl?.(loginEntryUrl);
      this.browser.setWorkspaceHint?.(null);
      this.auth = { status: 'signed_out', message: loginEntryUrl ? '登录入口已保存，请打开入口完成登录并进入飞瓜工作台' : '请先配置并保存登录入口网址' };
    });
    return this.state();
  }

  async login({ collectAfterLogin = true } = {}) {
    await this.exclusive(async () => {
      await this.configQueue;
      if (!this.data.loginEntryUrl) throw new Error('请先配置并保存登录入口网址');
      this.autoCollectRequested = collectAfterLogin === true;
      this.autoCatalogRequested = true;
      this.loginSequence++;
      try { await this.browser.openLogin(); }
      catch (error) { this.autoCollectRequested = false; this.autoCatalogRequested = false; throw error; }
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

  async start({ trigger = null } = {}) {
    const sequence = this.loginSequence;
    const cancelled = () => this.disposed || sequence !== this.loginSequence;
    await this.exclusive(async () => {
      await this.configQueue;
      if (cancelled()) return;
      const musicTag = [...this.data.musicTag];
      const keywords = [...this.data.keywords];
      const videoQueries = structuredClone(this.data.videoQueries);
      let auth;
      try { auth = await this.browser.checkLogin(); }
      catch (error) { if (cancelled()) return; throw error; }
      if (cancelled()) return;
      this.auth = auth;
      if (this.auth.status !== 'authenticated') throw new Error(this.auth.message || '请先登录飞瓜');
      const topicCheck = trigger === 'login' ? pendingTopicCheck({ ...this.data, musicTag }, Date.now(), { ignorePreviousCheck: true }) : null;
      const musicCheck = trigger === 'login' ? pendingMusicCheck({ ...this.data, musicTag }, Date.now(), { ignorePreviousCheck: true }) : null;
      await this.launchRun(musicTag, keywords, { videoQueries, trigger: trigger === 'login' ? 'login' : null, skipTopics: trigger === 'login' && !topicCheck, topicCheck, skipMusic: trigger === 'login' && !musicCheck, musicCheck });
    });
    return this.state();
  }

  async launchRun(musicTag, keywords, { onlyMusic = false, onlyRankings = false, onlyHotspots = false, onlyVideos = false, onlyTopics = false, skipTopics = false, skipMusic = false, verifyLogin = false, scheduledDate = null, videoQueries = this.data.videoQueries, trigger = null, topicCheck = null, musicCheck = null } = {}) {
    const sequence = this.operationSequence ?? this.loginSequence;
    if (this.disposed || sequence !== this.loginSequence) return;
    const groups = (onlyVideos ? [] : onlyMusic ? ['music'] : onlyRankings ? ['music', 'topics'] : onlyHotspots ? ['hotspots'] : onlyTopics ? ['topics'] : ['music', 'topics', 'hotspots']).filter(kind => (kind !== 'topics' || !skipTopics) && (kind !== 'music' || !skipMusic)).map(kind => ({ kind, keyword: null, status: 'pending', ...(['music','topics'].includes(kind) ? { musicTag: [...musicTag] } : {}) }));
    groups.push(...keywords.map(keyword => ({ kind: 'videos', keyword, status: 'pending', ...structuredClone(videoQueries.find(query => query.keyword === keyword) || { categoryPath: [], tagPath: [] }) })));
    const run = { id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null, status: 'running', keywords, musicTag, groups, ...(scheduledDate ? { scheduledDate, trigger: onlyVideos ? 'weekly-videos' : 'daily-hotspots' } : trigger ? { trigger } : {}), message: onlyMusic ? '正在刷新 BGM' : onlyRankings ? '正在刷新 BGM 和话题榜单' : onlyHotspots ? '正在更新每日热点榜' : onlyVideos ? '正在更新关键词视频榜单' : '准备采集' };
    const previousRuns = this.data.runs;
    const previousTopicsCheck = this.data.lastTopicsCheck;
    const previousMusicCheck = this.data.lastMusicCheck;
    if (musicCheck) { if (onlyMusic) run.trigger = 'daily-music'; run.musicCheck = structuredClone(musicCheck); this.data.lastMusicCheck = structuredClone(musicCheck); }
    if (topicCheck) { if (onlyTopics) run.trigger = 'weekly-topics'; run.topicCheck = structuredClone(topicCheck); this.data.lastTopicsCheck = structuredClone(topicCheck); }
    const scheduleKey = onlyVideos ? 'lastVideosScheduleDate' : 'lastHotspotsScheduleDate';
    const previousScheduleDate = this.data[scheduleKey];
    if (scheduledDate) this.data[scheduleKey] = scheduledDate;
    this.data.runs = [run, ...previousRuns].slice(0, 12);
    try { await this.persist(); } catch (error) { this.data.runs = previousRuns; this.data[scheduleKey] = previousScheduleDate; this.data.lastTopicsCheck = previousTopicsCheck; this.data.lastMusicCheck = previousMusicCheck; throw error; }
    this.storageMessage = null;
    if (this.disposed || sequence !== this.loginSequence) {
      run.status = 'cancelled'; run.finishedAt = new Date().toISOString(); run.message = '已取消，未开始采集';
      for (const group of groups) group.status = 'cancelled';
      await this.persist(); return;
    }
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.job = (async () => {
      if (verifyLogin) {
        try {
          this.auth = { status: 'checking', message: '正在检查飞瓜登录状态…' };
          run.message = '正在检查飞瓜登录状态…';
          await this.persist();
          this.auth = await this.browser.checkLogin();
          if (this.auth.status !== 'authenticated') throw new Error(onlyHotspots ? '请登录飞瓜后刷新日榜' : '设置已保存，请登录飞瓜后刷新榜单');
        } catch (error) {
          if (this.auth.status === 'checking') this.auth = { status: 'error', message: error.publicMessage || '飞瓜登录状态检查失败，请重试' };
          run.status = signal.aborted ? 'cancelled' : 'failed';
          run.finishedAt = new Date().toISOString();
          run.message = scheduledDate ? '每日定时采集未完成，请登录飞瓜后手动重试' : '分类榜单刷新未完成';
          for (const group of groups) { group.status = run.status; group.message = signal.aborted ? '已取消' : `设置已保存；${error.publicMessage || this.auth.message || '请点击“打开登录入口”重新登录'}`; }
          await this.persist(); return;
        }
      }
      this.catalogMessage = null;
      await this.execute(run, signal);
    })().catch(() => {
      run.status = 'failed'; run.message = '本机保存失败，已停止采集，请检查存储后重试';
      run.finishedAt = new Date().toISOString();
      this.storageMessage = run.message;
      for (const group of run.groups) {
        if (group.status === 'running') { group.status = 'failed'; group.message = run.message; }
        else if (group.status === 'pending') group.status = 'skipped';
      }
    }).finally(() => { this.controller = null; });
  }

  async saveCapturedGroup(run, group, result) {
    const save = this.writeQueue.then(async () => {
      const snapshot = structuredClone(this.data);
      const retained = group.kind === 'videos' ? retainProductFields(result, snapshot) : result;
      const savedRun = snapshot.runs.find(item => item.id === run.id);
      const savedGroup = savedRun.groups[run.groups.indexOf(group)];
      Object.assign(savedGroup, { result: retained, status: 'completed' });
      snapshot.latestResults = recoverLatestResults([{ id: run.id, groups: [savedGroup] }], snapshot.latestResults);
      if (group.kind === 'videos') snapshot.videoHistory = recoverVideoHistory([{ groups: [savedGroup] }], [], snapshot.videoHistory);
      await this.storage.write(snapshot);
      // Publishing follows the durable write. Polling must never see a result
      // that would disappear on restart after a failed save.
      Object.assign(group, { result: retained, status: 'completed' });
      this.data.latestResults = snapshot.latestResults;
      this.data.videoHistory = snapshot.videoHistory;
    });
    this.writeQueue = save.catch(() => {});
    try { await save; }
    catch (error) {
      throw Object.assign(new Error('本机结果保存失败，已保留上次结果并停止采集'), {
        code: 'FEIGUA_STORAGE', publicMessage: '本机结果保存失败，已保留上次结果并停止采集', cause: error,
      });
    }
  }

  async collectWithRetry(run, group, signal, options, index) {
    const waits = [10_000, 30_000];
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw Object.assign(new Error('已取消采集'), { code: 'FEIGUA_CANCELLED' });
      try { return await this.browser.collect(group.kind, group.keyword, signal, structuredClone(options)); }
      catch (error) {
        if (signal.aborted || error.code !== 'FEIGUA_NETWORK') throw error;
        if (attempt >= waits.length) throw Object.assign(new Error('自动重试后仍未完成，请稍后重新采集'), { code: 'FEIGUA_NETWORK', publicMessage: '已自动重试 2 次，仍未完成；保留上次结果，请稍后重新采集' });
        const ms = waits[attempt];
        group.status = 'retrying'; group.retryDelay = ms;
        group.message = `网络暂时不可用，${ms / 1000} 秒后自动重试（${attempt + 1}/${waits.length}）`;
        run.message = `${FEIGUA_SOURCES[group.kind].label}：${group.message}`;
        const persistRetry = async () => {
          try { await this.persist(); }
          catch { throw Object.assign(new Error('自动重试状态保存失败，已停止采集'), { code: 'FEIGUA_STORAGE', publicMessage: '自动重试状态保存失败，已保留上次结果并停止采集' }); }
        };
        await persistRetry();
        await this.retryWait(ms, signal);
        if (signal.aborted || this.disposed) throw Object.assign(new Error('已取消采集'), { code: 'FEIGUA_CANCELLED' });
        group.status = 'running'; group.attempts = attempt + 2; group.retryDelay = null; delete group.message;
        run.message = `正在重试${FEIGUA_SOURCES[group.kind].label}（第 ${group.attempts}/3 次，${index + 1}/${run.groups.length} 组）`;
        await persistRetry();
      }
    }
  }

  async execute(run, signal) {
    let stop = false;
    for (const [index, group] of run.groups.entries()) {
      if (signal.aborted || stop) { group.status = signal.aborted ? 'cancelled' : 'skipped'; continue; }
      group.status = 'running'; group.attempts = 1;
      run.message = `正在采集${group.keyword ? `「${group.keyword}」` : FEIGUA_SOURCES[group.kind].label}（${index + 1}/${run.groups.length}）`;
      await this.persist();
      try {
        const options = { musicTag: group.musicTag || [], categoryPath: group.categoryPath || [], tagPath: group.tagPath || [] };
        const capture = await this.collectWithRetry(run, group, signal, options, index);
        if (signal.aborted) { group.status = 'cancelled'; continue; }
        if (group.kind === 'music' && capture.musicTagOptions?.length) await this.cacheMusicTags({ options: capture.musicTagOptions, restricted: capture.musicTagRestricted });
        if (group.kind === 'videos' && capture.videoFilterOptions) await this.cacheVideoFilters(capture.videoFilterOptions);
        if (capture.catalogWarning) this.catalogMessage = '分类目录更新暂未完成，保留已有目录；本次数据仍按实际筛选校验';
        const result = validateCapture(group.kind, group.keyword, capture, { ...options, sourceOrigin: this.browser.sourceOrigin?.() });
        if (group.kind === 'topics' && run.topicCheck) {
          const period = settledTopicPeriod(result.dateRange, Date.parse(run.topicCheck.checkedAt));
          if (!period || period > run.topicCheck.expectedPeriod) throw Object.assign(new Error('来源话题周榜不是已结束的完整自然周'), { publicMessage: '来源话题周榜日期不符合已结束的完整自然周，本组未保存' });
          if (period < run.topicCheck.expectedPeriod) {
            group.status = 'waiting';
            group.message = `新一期话题周榜尚未发布（来源仍为 ${period}），保留已有结果，下次北京时间 09:00 再检查`;
            continue;
          }
        }
        await this.saveCapturedGroup(run, group, result);
        continue;
      } catch (error) {
        group.status = signal.aborted ? 'cancelled' : 'failed'; group.retryDelay = null;
        // Only adapter-owned messages are exposed, never raw browser/network errors.
        group.message = signal.aborted ? '已取消' : error.publicMessage || '本组采集未通过校验，请打开飞瓜核对页面后重试';
        if (error.code === 'FEIGUA_STORAGE') throw error;
        if (['FEIGUA_QUOTA', 'FEIGUA_RATE_LIMIT'].includes(error.code)) stop = true;
        if (error.code === 'FEIGUA_AUTH_REQUIRED') {
          this.auth = { status: 'expired', message: '飞瓜登录已失效，请重新登录' }; stop = true;
        }
        if (error.code === 'FEIGUA_NOTICE_FAILED') {
          this.auth = { status: 'error', message: error.publicMessage }; stop = true;
        }
        if (error.code === 'FEIGUA_VERIFICATION_REQUIRED') {
          this.auth = { status: 'verification_required', message: error.publicMessage }; stop = true;
        }
      }
      await this.persist();
    }
    const completed = run.groups.filter(group => group.status === 'completed').length;
    run.status = signal.aborted ? 'cancelled' : completed === run.groups.length ? 'completed' : completed ? 'partial' : 'failed';
    run.finishedAt = new Date().toISOString();
    run.message = `${signal.aborted ? '已取消；' : ''}完成 ${completed}/${run.groups.length} 组`;
    if (!signal.aborted && run.topicCheck && run.groups.every(group => group.status === 'waiting')) { run.status = 'waiting'; run.message = run.groups[0].message; }
    await this.persist();
  }

  async cancel() {
    this.autoCollectRequested = false;
    this.autoCatalogRequested = false;
    this.loginSequence++;
    this.controller?.abort();
    this.browser.stop?.();
    return this.state();
  }

  dispose() { this.disposed = true; clearInterval(this.scheduleTimer); this.scheduleTimer = null; this.autoCollectRequested = false; this.autoCatalogRequested = false; this.loginSequence++; this.controller?.abort(); this.browser.dispose?.(); }
}
