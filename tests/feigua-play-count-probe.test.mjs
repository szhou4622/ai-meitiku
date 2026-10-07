import assert from 'node:assert/strict';
import test from 'node:test';
import { FEIGUA_PLAY_PROBE_ENDPOINT, inspectFeiguaPlayProbe } from '../scripts/lib/feigua-play-count-probe.mjs';
import { parseProbeOptions, readObservedDetailProbe } from '../scripts/probe-feigua-video-plays.mjs';

function fixture() {
  return {
    context: { awemeId: '10001', publicationDate: '2026-10-01', cutoffDate: '2026-10-07' },
    request: { method: 'GET', endpoint: FEIGUA_PLAY_PROBE_ENDPOINT, params: { awemeId: '10001', promotionId: '20001', dateCode: '20261001', sign: 'private-value' } },
    identityResponse: { Code: 200, Status: true, Data: { AwemeId: '10001', DateCode: 20261001, PlayCount: 0, PlayCountStr: null } },
    response: { Code: 200, Status: true, Data: [
      { DateCode: 20261006, PlayCount: 100, IncPlayCount: 100, GPM: 55 },
      { DateCode: 20261007, PlayCount: 120, IncPlayCount: 20, GPM: 55 },
    ] },
  };
}

test('positive product trend remains a candidate with its own scope and date; no secrets or plays overwrite', () => {
  const result = inspectFeiguaPlayProbe(fixture());
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidatePlayCount, '120');
  assert.equal(result.asOfDate, '2026-10-07');
  assert.equal(result.scope, 'promotion-trend');
  assert.equal(result.verifiedAsVideoTotal, false);
  assert.equal(Object.hasOwn(result, 'plays'), false);
  assert.doesNotMatch(JSON.stringify(result), /private-value|sign|GPM/);
});

test('zero, missing, unsafe and regressing latest points cannot fall back to an older positive value', () => {
  for (const [plays, increment] of [[0, -100], [0, 0], [null, 0], ['--', 0], [90, 0], [120, -1], [120, null], [Number.MAX_SAFE_INTEGER + 1, 1], ['1e3', 1], ['', 0]]) {
    const input = fixture();
    Object.assign(input.response.Data[1], { PlayCount: plays, IncPlayCount: increment });
    assert.equal(inspectFeiguaPlayProbe(input).status, 'unavailable');
  }
});

test('selects the latest date, preserves earlier as-of dates and does not sum cumulative counts', () => {
  const input = fixture(); input.response.Data.reverse();
  assert.equal(inspectFeiguaPlayProbe(input).candidatePlayCount, '120');
  input.response.Data = input.response.Data.filter(point => point.DateCode === 20261006);
  assert.equal(inspectFeiguaPlayProbe(input).asOfDate, '2026-10-06');
  assert.equal(inspectFeiguaPlayProbe(input).candidatePlayCount, '100');
});

test('rejects another video, product-less queries, another endpoint, wrong publication dates and identity responses', () => {
  for (const mutation of [
    input => { input.request.params.awemeId = '10002'; },
    input => { input.request.params.promotionId = ''; },
    input => { input.request.endpoint = '/api/v3/aweme/detail/detail/sumData'; },
    input => { input.request.method = 'POST'; },
    input => { input.request.params.dateCode = '20261002'; },
    input => { input.identityResponse.Data.AwemeId = '10002'; },
    input => { input.identityResponse.Data.DateCode = 20261002; },
    input => { input.identityResponse.Code = 403; },
  ]) { const input = fixture(); mutation(input); assert.equal(inspectFeiguaPlayProbe(input).status, 'unavailable'); }
});

test('invalid, duplicate, pre-publication and future dates cannot escape the collection cutoff', () => {
  for (const date of [20260230, 20261008, 20260930, 20261006, null]) {
    const input = fixture(); input.response.Data[1].DateCode = date;
    assert.equal(inspectFeiguaPlayProbe(input).status, 'unavailable');
  }
  const input = fixture(); input.context.cutoffDate = '2026-02-30';
  assert.equal(inspectFeiguaPlayProbe(input).reason, 'invalid-context');
});

test('permission failures, examples, empty and malformed responses never become candidate counts', () => {
  for (const response of [
    { Code: 403, Status: false, Data: fixture().response.Data },
    { Code: 200, Status: false, Data: fixture().response.Data },
    { Code: 200, Status: true, ExampleData: {}, Data: fixture().response.Data },
    { Code: 200, Status: true, Data: [] },
    { Code: 200, Status: true, Data: { PlayCount: 1000 } },
  ]) { const input = fixture(); input.response = response; assert.equal(inspectFeiguaPlayProbe(input).status, 'unavailable'); }
});

test('CLI requires a pinned origin and port and validates options', () => {
  assert.deepEqual(parseProbeOptions(['--help']), { help: true });
  assert.deepEqual(parseProbeOptions(['--port', '45001', '--origin', 'http://192.0.2.1:1234', '--cutoff', '2026-10-07']), {
    port: 45001, origin: 'http://192.0.2.1:1234', cutoffDate: '2026-10-07',
  });
  for (const args of [
    [], ['--port', '0', '--origin', 'https://dy.feigua.cn'],
    ['--port', '45001', '--origin', 'https://name:password@dy.feigua.cn'],
    ['--port', '45001', '--origin', 'https://dy.feigua.cn/app/'],
    ['--port', '45001', '--origin', 'https://dy.feigua.cn', '--limit', '6'],
    ['--port', '45001', '--origin', 'https://dy.feigua.cn', '--cutoff', '2026-02-30'],
    ['--port', '45001', '--port', '45002', '--origin', 'https://dy.feigua.cn'],
    ['--unknown', 'value'],
  ]) assert.throws(() => parseProbeOptions(args));
});

test('page reader replays observed queries, binds video identity and exports only allowed fields', async () => {
  const saved = { document: globalThis.document, location: globalThis.location, performance: globalThis.performance };
  const origin = 'https://dy.feigua.cn';
  const route = { path: '/video-detail/index', fullPath: '/video-detail/index?awemeId=10001&dateCode=20261001', query: { awemeId: '10001', dateCode: '20261001' } };
  const endpoints = ['/api/v3/aweme/detail/detail/mainPart', '/api/v3/aweme/detail/detail/sumData', FEIGUA_PLAY_PROBE_ENDPOINT];
  const calls = [];
  const video = Object.fromEntries(endpoints.map((url, index) => [index, { url, GET: async ({ params }) => {
    calls.push({ url, params });
    return { Code: 200, Status: true, Token: 'secret-token', Data: url === FEIGUA_PLAY_PROBE_ENDPOINT
      ? [{ DateCode: 20261007, PlayCount: 100, IncPlayCount: 20, Sign: 'secret-sign' }]
      : { AwemeId: '10001', DateCode: 20261001, PlayCount: 0, PlayCountStr: null, Sign: 'secret-sign' } };
  } }]));
  globalThis.document = { querySelector: () => ({ __vue__: { $route: route, $api: { video } } }) };
  globalThis.location = { origin };
  globalThis.performance = { getEntriesByType: () => endpoints.map(endpoint => ({ name: `${origin}${endpoint}?awemeId=10001&dateCode=20261001&promotionId=20001&sign=secret-sign` })) };
  try {
    const result = await readObservedDetailProbe({ origin });
    assert.equal(calls.length, 3); assert.equal(calls[2].params.sign, 'secret-sign');
    assert.doesNotMatch(JSON.stringify(result), /secret-sign|secret-token|Token|Sign/);
    assert.equal(inspectFeiguaPlayProbe({ context: { ...result.context, cutoffDate: '2026-10-07' }, request: result.records[2].request, response: result.records[2].response, identityResponse: result.records[0].response }).status, 'candidate');
    assert.equal((await readObservedDetailProbe({ origin: 'https://wrong.example' })).error, 'detail-context-mismatch');
    globalThis.performance.getEntriesByType = () => [];
    assert.equal((await readObservedDetailProbe({ origin })).error, 'detail-request-not-observed');
    globalThis.performance.getEntriesByType = () => endpoints.map(endpoint => ({ name: `${origin}${endpoint}?awemeId=10002&dateCode=20261001` }));
    assert.equal((await readObservedDetailProbe({ origin })).error, 'detail-request-not-observed');
    globalThis.performance.getEntriesByType = () => endpoints.map(endpoint => ({ name: `${origin}${endpoint}?awemeId=10001&dateCode=20261001` }));
    video[0].GET = async () => { route.fullPath = '/another-page'; return { Code: 200, Status: true }; };
    assert.equal((await readObservedDetailProbe({ origin })).error, 'detail-context-changed');
  } finally { Object.assign(globalThis, saved); }
});
