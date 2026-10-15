import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { QianchuanService, qianchuanInternals } from "../electron/qianchuan-service.mjs";

test("qianchuan download URL validation rejects local and non-HTTPS targets", () => {
  assert.throws(() => qianchuanInternals.assertSafeDownloadUrl("http://cdn.example.com/video.mp4"), /不安全/);
  assert.throws(() => qianchuanInternals.assertSafeDownloadUrl("https://127.0.0.1/video.mp4"), /不安全/);
  assert.throws(() => qianchuanInternals.assertSafeDownloadUrl("https://192.168.1.8/video.mp4"), /不安全/);
  assert.equal(qianchuanInternals.assertSafeDownloadUrl("https://cdn.example.com/video.mp4").hostname, "cdn.example.com");
});

test("qianchuan import filenames cannot traverse out of the selected directory", () => {
  assert.equal(qianchuanInternals.safeFilename("../../evil.mp4"), "evil.mp4");
  assert.equal(qianchuanInternals.safeFilename("bad:name?.mp4"), "bad_name_.mp4");
});

test("qianchuan CDN downloads keep the official referer and request the complete byte range", () => {
  assert.deepEqual(qianchuanInternals.qianchuanDownloadHeaders(), {
    Referer: "https://qianchuan.jinritemai.com/",
    Range: "bytes=0-",
  });
});

test("qianchuan authorization URL is restricted to the official flow and fixed callback", () => {
  const valid = "https://qianchuan.jinritemai.com/openapi/qc/audit/oauth.html?app_id=1875843873586284&redirect_uri=https%3A%2F%2Fapi.dadaozixun.com%2Fqianchuan%2Fcallback&state=one-time-state";
  assert.equal(qianchuanInternals.assertSafeAuthorizationUrl(valid).hostname, "qianchuan.jinritemai.com");
  assert.throws(() => qianchuanInternals.assertSafeAuthorizationUrl(valid.replace("qianchuan.jinritemai.com", "example.com")), /校验失败/);
  assert.throws(() => qianchuanInternals.assertSafeAuthorizationUrl(valid.replace("api.dadaozixun.com", "evil.example.com")), /校验失败/);
});

test("embedded qianchuan OAuth navigation allows only official HTTPS pages and the fixed callback", () => {
  assert.equal(
    qianchuanInternals.assertSafeQianchuanOauthNavigation("https://open.oceanengine.com/login").hostname,
    "open.oceanengine.com",
  );
  assert.equal(
    qianchuanInternals.assertSafeQianchuanOauthNavigation("https://api.dadaozixun.com/qianchuan/callback?state=test").pathname,
    "/qianchuan/callback",
  );
  assert.equal(qianchuanInternals.isQianchuanOauthCallback("https://api.dadaozixun.com/qianchuan/callback?state=test"), true);
  assert.throws(() => qianchuanInternals.assertSafeQianchuanOauthNavigation("http://open.oceanengine.com/login"), /已阻止/);
  assert.throws(() => qianchuanInternals.assertSafeQianchuanOauthNavigation("https://oceanengine.com.evil.example/login"), /已阻止/);
  assert.throws(() => qianchuanInternals.assertSafeQianchuanOauthNavigation("https://api.dadaozixun.com/other"), /已阻止/);
});

test("qianchuan browser mode defaults safely to the embedded browser", () => {
  assert.equal(qianchuanInternals.normalizeQianchuanBrowserMode("system"), "system");
  assert.equal(qianchuanInternals.normalizeQianchuanBrowserMode("embedded"), "embedded");
  assert.equal(qianchuanInternals.normalizeQianchuanBrowserMode("external-command"), "embedded");
  assert.equal(qianchuanInternals.normalizeQianchuanBrowserMode(undefined), "embedded");
});

test("qianchuan app secret is sent only to the protected config endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/v1/qianchuan/session/exchange")) {
      return new Response(JSON.stringify({ access_token: "scoped-qianchuan-session", expires_in: 600 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      success: true, configured: true, app_id: "1875843873586284", secret_configured: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const service = new QianchuanService({
    secureStore: { readCredential: async () => ({ deviceSession: "license-session", deviceCredential: "license-credential" }) },
    fetchImpl,
  });
  const secret = "client-test-secret-never-persist";
  const result = await service.saveAppConfig({ app_id: "1875843873586284", app_secret: secret });
  assert.equal(result.secret_configured, true);
  assert.match(calls[1].options.body, /client-test-secret-never-persist/);
  assert.doesNotMatch(JSON.stringify(result), /client-test-secret-never-persist/);
  assert.equal(service.appSecret, undefined);
});

test("renderer-facing resolve result strips provider download URL", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/v1/qianchuan/session/exchange")) {
      return new Response(JSON.stringify({ access_token: "scoped-qianchuan-session", expires_in: 600 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true, video: {
      material_id: "123456", download_available: true, download_url: "https://cdn.example.com/video.mp4",
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const service = new QianchuanService({
    secureStore: { readCredential: async () => ({ deviceSession: "license-session", deviceCredential: "license-credential" }) },
    fetchImpl,
  });
  const result = await service.resolve({ authorization_id: "qca-test", advertiser_id: "123456", reference: "123456" });
  assert.equal(result.video.download_url, undefined);
  assert.equal(calls[0].options.headers.Authorization, "Bearer license-session");
  assert.equal(calls[1].options.headers.Authorization, "Bearer scoped-qianchuan-session");
  assert.equal(calls[1].options.headers["X-Device-Credential"], undefined);
  assert.doesNotMatch(calls[1].options.body, /license-credential|license-session/);
});

test("optional Qianchuan insight report is requested only for a selected material", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/v1/qianchuan/session/exchange")) {
      return new Response(JSON.stringify({ access_token: "scoped-session", expires_in: 600 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true, found: true, data: { material_id: "123456" }, insights: {
      available: true,
      metrics: { live_convert_rate_for_roi2_v2: 3.5, total_ecpm_for_roi2: 75 },
      material: { material_create_time_v2: "2026-09-01" },
      daily_trend: [{ date: "1788796800000", spend: 20, gmv: 60, roi: 3, video_plays: 100 }],
    } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const service = new QianchuanService({
    secureStore: { readCredential: async () => ({ deviceSession: "license-session", deviceCredential: "license-credential" }) },
    fetchImpl,
  });
  const result = await service.report({ authorization_id: "qca-test", advertiser_id: "789", material_id: "123456", include_insights: true });
  assert.equal(result.insights.metrics.conversion_rate_percent, 3.5);
  assert.equal(result.insights.metrics.cpm, 75);
  assert.deepEqual(result.insights.material.created_at, ["2026-09-01"]);
  assert.deepEqual(result.insights.daily_trend, [{ date: "2026-09-08", spend: 20, paid_gmv: 60, paid_roi: 3, video_plays: 100 }]);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/api\/v1\/qianchuan\/media\/report$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { authorization_id: "qca-test", advertiser_id: "789", material_id: "123456", include_insights: true });
  assert.doesNotMatch(calls[1].options.body, /license-session|license-credential|scoped-session/);
});

test("Qianchuan insight normalization keeps unavailable provider fields as null", () => {
  const result = qianchuanInternals.normalizeQianchuanReportResponse({
    success: true,
    insights: {
      available: false,
      metrics: { live_convert_rate_for_roi2_v2: null, total_ecpm_for_roi2: null },
      material: { material_id: "123456", material_create_time_v2: null },
      unavailable_groups: ["traffic_conversion"],
    },
  });
  assert.equal(result.insights.available, false);
  assert.equal(result.insights.metrics.conversion_rate_percent, null);
  assert.equal(result.insights.metrics.cpm, null);
  assert.deepEqual(result.insights.unavailable_groups, ["traffic_conversion"]);
});

test("large-account library sync reads pages once and restores its safe local cache", async (t) => {
  const userDataPath = await mkdtemp(path.join(tmpdir(), "qianchuan-library-cache-"));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  const calls = [];
  let activeInsightRequests = 0;
  let maximumInsightConcurrency = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/v1/qianchuan/session/exchange")) {
      return new Response(JSON.stringify({ access_token: "scoped-session", expires_in: 600 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const payload = JSON.parse(options.body || "{}");
    if (url.endsWith("/api/v1/qianchuan/media/videos")) {
      const items = payload.page === 1 ? [
        { advertiser_id: payload.advertiser_id, material_id: "101001", video_id: "v1", filename: "最新素材.mp4", source: "QIANCHUAN", created_at: "2026-09-11 12:00:00", poster_url: "https://cdn.example.com/poster-1.jpg", duration_seconds: 31, width: 1080, height: 1920, download_available: true },
        { advertiser_id: payload.advertiser_id, material_id: "101002", video_id: "v2", filename: "第二条.mp4", source: "QIANCHUAN", created_at: "2026-09-10 12:00:00" },
      ] : [
        { advertiser_id: payload.advertiser_id, material_id: "101003", video_id: "v3", filename: "第三条.mp4", source: "QIANCHUAN", created_at: "2026-09-09 12:00:00" },
      ];
      return new Response(JSON.stringify({ success: true, items, page_info: { page: payload.page, total_page: 2, total_number: 3 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/v1/qianchuan/media/top")) {
      return new Response(JSON.stringify({ success: true, start_date: payload.start_date, end_date: payload.end_date, items: [
        { advertiser_id: payload.advertiser_id, material_id: "101002", filename: "第二条.mp4", material_type: "2", spend: 88, video_plays: 1200 },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/v1/qianchuan/media/report")) {
      activeInsightRequests += 1;
      maximumInsightConcurrency = Math.max(maximumInsightConcurrency, activeInsightRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeInsightRequests -= 1;
      return new Response(JSON.stringify({
        success: true,
        found: true,
        data: { material_id: payload.material_id },
        insights: {
          available: true,
          metrics: { live_convert_rate_for_roi2_v2: Number(payload.material_id.slice(-1)) },
          material: {},
          daily_trend: [],
          unavailable_groups: [],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const secureStore = { readCredential: async () => ({ deviceSession: "license-session", deviceCredential: "license-credential" }) };
  const service = new QianchuanService({ secureStore, userDataPath, fetchImpl });
  const progress = [];
  const result = await service.syncLibrary({
    authorization_id: "qca_cache_test",
    advertiser_id: "1862251436023940",
    material_mode: "recent",
    material_limit: 50,
    material_start_date: "",
    material_end_date: "",
    report_start_date: "2026-09-01",
    report_end_date: "2026-09-11",
  }, (next) => progress.push(next));
  assert.equal(result.success, true);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].material_id, "101002");
  assert.equal(result.items[0].spend, 88);
  assert.equal(result.items.find((item) => item.material_id === "101001").poster_url, "https://cdn.example.com/poster-1.jpg");
  assert.equal(result.items.find((item) => item.material_id === "101001").duration_seconds, 31);
  assert.equal(calls.filter((call) => call.url.endsWith("/media/videos")).length, 2);
  assert.equal(calls.filter((call) => call.url.endsWith("/media/report")).length, 3);
  assert.equal(maximumInsightConcurrency, 3);
  assert.ok(progress.some((item) => item.stage === "materials" && item.page === 2));
  assert.ok(progress.some((item) => item.stage === "insights" && item.items?.length === 3));
  assert.equal(result.insights_completed, 3);
  assert.equal(result.insights_by_material["101002"].insights.metrics.conversion_rate_percent, 2);
  assert.equal(progress.at(-1).stage, "complete");

  const reopened = new QianchuanService({ secureStore, userDataPath, fetchImpl: async () => { throw new Error("cache must not use network"); } });
  const cached = await reopened.libraryCache({ authorization_id: "qca_cache_test", advertiser_id: "1862251436023940" });
  assert.equal(cached.cache.items.length, 3);
  assert.equal(cached.cache.items.find((item) => item.material_id === "101001").poster_url, "https://cdn.example.com/poster-1.jpg");
  assert.equal(cached.cache.query.material_limit, 50);
  assert.equal(cached.cache.insights_completed, 3);
  assert.equal(cached.cache.insights_by_material["101003"].insights.metrics.conversion_rate_percent, 3);
  assert.equal(cached.resumable, false);
  const rawCache = await readFile(path.join(userDataPath, "qianchuan", "viral-library-cache.v1.json"), "utf8");
  assert.doesNotMatch(rawCache, /license-session|license-credential|scoped-session/);
});

for (const scenario of [
  { name: 'account permission rejected', status: 403, body: { detail: '素材权限不足' }, expected: /素材权限不足/ },
  { name: 'HTTP 200 business failure', status: 200, body: { success: false, message: '账户不可读取' }, expected: /账户不可读取/ },
  { name: 'malformed response', status: 200, raw: '<html>gateway</html>', expected: /无法解析/ },
]) {
  test(`qianchuan keeps account and endpoint context: ${scenario.name}`, async () => {
    const service = new QianchuanService({ secureStore: {}, fetchImpl: async () => new Response(scenario.raw || JSON.stringify(scenario.body), { status: scenario.status }) });
    service.accessToken = async () => 'synthetic-session';
    await assert.rejects(service.videos({ advertiser_id: '123456' }), error => {
      assert.match(error.message, scenario.expected);
      assert.equal(error.endpoint, '/api/v1/qianchuan/media/videos');
      assert.equal(error.advertiserId, '123456');
      assert.equal(error.httpStatus, scenario.status);
      return true;
    });
  });
}

test('qianchuan network failure retains cause and selected advertiser context', async () => {
  const cause = Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' });
  const service = new QianchuanService({ secureStore: {}, fetchImpl: async () => { throw cause; } });
  service.accessToken = async () => 'synthetic-session';
  await assert.rejects(service.top({ advertiser_id: '123456' }), error => {
    assert.equal(error.cause, cause);
    assert.equal(error.code, 'ECONNRESET');
    assert.equal(error.advertiserId, '123456');
    assert.equal(error.endpoint, '/api/v1/qianchuan/media/top');
    return true;
  });
});

test('partial insight failure preserves base materials and emits the actual account-specific error', async (t) => {
  const userDataPath = await mkdtemp(path.join(tmpdir(), 'qianchuan-partial-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  const service = new QianchuanService({ secureStore: {}, userDataPath });
  service.videos = async () => ({ items: [{ material_id: '101001', video_id: '101001', filename: 'test.mp4' }], page_info: { total_page: 1, total_number: 1 } });
  service.top = async () => ({ items: [] });
  service.report = async () => { throw new Error('该账户无扩展报表权限'); };
  const progress = [];
  const result = await service.syncLibrary({ authorization_id: 'qca_synthetic', advertiser_id: '123456', material_mode: 'latest', material_limit: 50, report_start_date: '2026-10-01', report_end_date: '2026-10-13' }, value => progress.push(value));
  assert.equal(result.success, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.insights_failed, 1);
  const failure = progress.find(value => value.insight_failed);
  assert.equal(failure.advertiser_id, '123456');
  assert.equal(failure.insight_material_id, '101001');
  assert.equal(failure.insight_error, '该账户无扩展报表权限');
});

const progressiveQuery = { authorization_id: 'qca_progressive', advertiser_id: '123456', material_mode: 'recent', material_limit: 50, report_start_date: '2026-10-01', report_end_date: '2026-10-13' };
const candidate = id => ({ material_id: id, video_id: id, filename: `${id}.mp4`, created_at: '2026-10-10', poster_url: 'https://cdn.example.com/poster.jpg' });
async function progressiveFixture(t) {
  const userDataPath = await mkdtemp(path.join(tmpdir(), 'qianchuan-progressive-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  const service = new QianchuanService({ secureStore: {}, userDataPath });
  service.top = async () => ({ items: [] });
  service.report = async () => ({ insights: { available: true, metrics: { cpc: 1 } } });
  return { service, userDataPath };
}

test('each page is visible and durable before later pages or performance finish; retry resumes without duplicates', async t => {
  const { service, userDataPath } = await progressiveFixture(t);
  let secondPageFails = true;
  const pages = [];
  const videos = async ({ page }) => {
    pages.push(page);
    if (page === 2 && secondPageFails) throw new Error('page two timeout');
    return { items: page === 1 ? [candidate('101001')] : [candidate('101001'), candidate('101002')], page_info: { total_page: 2, total_number: 3 } };
  };
  service.videos = videos;
  let topCalled = false;
  service.top = async () => { topCalled = true; return { items: [] }; };
  const progress = [];
  await assert.rejects(service.syncLibrary(progressiveQuery, value => {
    progress.push(value);
    if (value.stage === 'materials') assert.equal(topCalled, false);
  }), /page two timeout/);
  const firstPage = progress.find(value => value.stage === 'materials');
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].performance_pending, true);
  assert.equal(progress.at(-1).stage, 'error');
  const reopened = new QianchuanService({ secureStore: {}, userDataPath });
  const cache = await reopened.libraryCache(progressiveQuery);
  assert.equal(cache.resumable, true);
  assert.equal(cache.cache.items.length, 1);
  assert.equal(cache.cache.items[0].performance_pending, true);
  secondPageFails = false;
  reopened.videos = videos;
  reopened.top = service.top;
  reopened.report = service.report;
  const result = await reopened.syncLibrary(progressiveQuery);
  assert.deepEqual(pages, [1, 2, 2]);
  assert.deepEqual(result.items.map(item => item.material_id), ['101001', '101002']);
  assert.equal((await reopened.libraryCache(progressiveQuery)).resumable, false);
});

test('overlapping sync merges video cards and reuses insights only for the exact fresh report interval', async t => {
  const { service } = await progressiveFixture(t);
  let materialIds = ['101001', '101002'];
  let reports = 0, lists = 0, tops = 0;
  service.videos = async () => { lists++; return { items: materialIds.map(candidate), page_info: { total_page: 1 } }; };
  service.top = async () => { tops++; return { items: [] }; };
  service.report = async () => { reports++; return { insights: { available: true, metrics: { cpc: reports } } }; };
  await service.syncLibrary(progressiveQuery);
  assert.equal(reports, 2);
  materialIds = ['101002', '101003', '101002'];
  const result = await service.syncLibrary(progressiveQuery);
  assert.deepEqual(result.items.map(item => item.material_id), ['101002', '101003']);
  assert.equal(reports, 3); // Only the newly discovered video needs an insight request.
  const otherRange = { ...progressiveQuery, report_start_date: '2026-10-05' };
  await service.syncLibrary(otherRange);
  assert.equal(reports, 5); // An overlapping interval is still a different aggregation.
  await service.syncLibrary(progressiveQuery);
  assert.equal(reports, 5); // Returning to the previous interval restores that interval's cache.
  assert.equal(lists, 4);
  assert.equal(tops, 4); // Explicit sync always refreshes mutable base performance.
  materialIds = ['101001'];
  await service.syncLibrary(progressiveQuery);
  assert.equal(reports, 5); // Older overlapping material remains in the interval cache.
  await service.syncLibrary({ ...progressiveQuery, advertiser_id: '654321' });
  assert.equal(reports, 6); // Another advertiser must not inherit cached metrics.
});

test('cancelling after the first page preserves its cards and resumes at the next page', async t => {
  const { service } = await progressiveFixture(t);
  const pages = [];
  service.videos = async ({ page }) => { pages.push(page); return { items: [candidate(String(101000 + page))], page_info: { total_page: 2 } }; };
  const cancelled = await service.syncLibrary(progressiveQuery, value => {
    if (value.stage === 'materials') service.cancelLibrarySync();
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await service.libraryCache(progressiveQuery)).cache.items.length, 1);
  const resumed = await service.syncLibrary(progressiveQuery);
  assert.equal(resumed.items.length, 2);
  assert.deepEqual(pages, [1, 2]);
});

test('duplicate sync requests share the running job instead of cancelling it', async t => {
  const { service } = await progressiveFixture(t);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let lists = 0;
  service.videos = async () => { lists++; started(); await gate; return { items: [candidate('101001')], page_info: { total_page: 1 } }; };
  const firstProgress = [], secondProgress = [];
  const first = service.syncLibrary(progressiveQuery, p => firstProgress.push(p));
  await ready;
  const second = service.syncLibrary({ ...progressiveQuery }, p => secondProgress.push(p));
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.success && !result.cancelled));
  assert.equal(lists, 1);
  assert.ok(firstProgress.some(p => p.stage === 'complete'));
  assert.ok(secondProgress.some(p => p.stage === 'complete'));
});

test('a different account cannot silently cancel a running sync', async t => {
  const { service } = await progressiveFixture(t);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  service.videos = async () => { started(); await gate; return { items: [candidate('101001')], page_info: { total_page: 1 } }; };
  const first = service.syncLibrary(progressiveQuery);
  await ready;
  await assert.rejects(service.syncLibrary({ ...progressiveQuery, advertiser_id: '654321' }), { code: 'TASK_IN_PROGRESS' });
  assert.equal(service.activeLibrarySync.cancelled, false);
  release();
  assert.equal((await first).success, true);
});

test('immediate continuation waits for cancellation to save and preserves the next-page checkpoint', async t => {
  const { service } = await progressiveFixture(t);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pages = [];
  service.videos = async ({ page }) => { pages.push(page); return { items: [candidate(String(101000 + page))], page_info: { total_page: 2 } }; };
  const update = service.updateLibraryCacheStore.bind(service);
  let holdCancelledCheckpoint = true;
  service.updateLibraryCacheStore = async (...args) => {
    if (service.activeLibrarySync?.cancelled && holdCancelledCheckpoint) {
      holdCancelledCheckpoint = false; started(); await gate;
    }
    return update(...args);
  };
  const first = service.syncLibrary(progressiveQuery, p => { if (p.stage === 'materials') service.cancelLibrarySync(); });
  await ready;
  const resumed = service.syncLibrary(progressiveQuery);
  release();
  assert.equal((await first).cancelled, true);
  assert.equal((await resumed).success, true);
  assert.deepEqual(pages, [1, 2]);
  assert.equal((await service.libraryCache(progressiveQuery)).resumable, false);
});

test('cache read failure releases the active sync so retry can start', async t => {
  const { service } = await progressiveFixture(t);
  const read = service.readLibraryCacheStore.bind(service);
  service.readLibraryCacheStore = async () => { throw new Error('synthetic disk failure'); };
  await assert.rejects(service.syncLibrary(progressiveQuery), /synthetic disk failure/);
  assert.equal(service.activeLibrarySync, null);
  service.readLibraryCacheStore = read;
  service.videos = async () => ({ items: [], page_info: { total_page: 1 } });
  assert.equal((await service.syncLibrary(progressiveQuery)).success, true);
});
