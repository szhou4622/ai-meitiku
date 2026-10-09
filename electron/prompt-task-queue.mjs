export function createPromptTaskQueue({ concurrency = 3, maxRetries = 3, retryDelayMs = 2000, recoveryMs = 30000, onChange = () => {} } = {}) {
  const maximum = Math.max(1, Math.min(8, Math.floor(concurrency)));
  let limit = maximum;
  let active = 0;
  let requests = 0;
  let cooldownUntil = 0;
  let lastLimitedAt = 0;
  let successes = 0;
  let timer;
  const pending = new Map();
  const jobs = [];
  const permits = [];
  const emit = (id, state, message) => {
    const task = pending.get(id);
    if (!task) return;
    Object.assign(task, { state, message });
    onChange({ id, state, message, concurrency: limit });
  };
  const publishLimit = () => {
    for (const [id, task] of pending) emit(id, task.state, task.message);
  };
  function pump() {
    clearTimeout(timer);
    const remaining = cooldownUntil - Date.now();
    if (remaining > 0) {
      timer = setTimeout(pump, remaining);
      return;
    }
    while (requests < limit && permits.length) {
      requests++;
      permits.shift()();
    }
    while (active < limit && jobs.length) {
      const job = jobs.shift();
      active++;
      emit(job.id, "running", "生成中");
      const finish = () => { active--; pending.delete(job.id); pump(); };
      Promise.resolve().then(job.work).then(value => { finish(); job.resolve(value); }, error => { finish(); job.reject(error); });
    }
  }
  return {
    get concurrency() { return limit; },
    enqueue(id, work) {
      if (pending.has(id)) return Promise.reject(new Error("该提示词已有任务正在生成或排队"));
      pending.set(id, { state: "queued", message: "排队中" });
      emit(id, "queued", "排队中");
      return new Promise((resolve, reject) => {
        jobs.push({ id, work, resolve, reject });
        pump();
      });
    },
    progress(id, message) { emit(id, "running", message); },
    async request(id, send) {
      for (let attempt = 0; ; attempt++) {
        if (cooldownUntil > Date.now()) emit(id, "retrying", "等待重试");
        await new Promise(resolve => { permits.push(resolve); pump(); });
        emit(id, "running", "生成中");
        let response;
        try { response = await send(); }
        catch (error) { requests--; pump(); throw error; }
        requests--;
        if (response.status !== 429) {
          if (response.ok && limit < maximum) {
            successes++;
            if (successes >= 6 && Date.now() - lastLimitedAt >= recoveryMs) {
              limit++;
              successes = 0;
              publishLimit();
            }
          }
          pump();
          return response;
        }
        const body = await response.clone().json().catch(() => ({}));
        if (/insufficient_quota|quota_exhausted|billing|balance/i.test(String(body?.error?.code || ""))) {
          pump();
          return response;
        }
        limit = Math.max(1, Math.floor(limit / 2));
        lastLimitedAt = Date.now();
        successes = 0;
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter || "") - Date.now();
        const delay = Math.max(retryDelayMs * 2 ** attempt, Number.isFinite(headerDelay) ? headerDelay : 0);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
        emit(id, "retrying", "等待重试");
        publishLimit();
        pump();
        if (attempt >= maxRetries) return response;
        await response.body?.cancel().catch(() => {});
      }
    },
  };
}
