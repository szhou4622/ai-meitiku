import { pathToFileURL } from 'node:url';
import { FEIGUA_PLAY_PROBE_ENDPOINT, inspectFeiguaPlayProbe } from './lib/feigua-play-count-probe.mjs';

const HELP = `Usage: node scripts/probe-feigua-video-plays.mjs --port PORT --origin ORIGIN [--cutoff YYYY-MM-DD]

Requires Node 22.13+ and an existing logged-in Electron video-detail window.
Replays only that detail's observed mainPart, sumData and product-trend GET
queries through its normal API client. No navigation or saved-result writes.
Outputs a product-scoped candidate, never a verified total video play count.
Signed URLs, headers and account data are not exported.
`;

export function parseProbeOptions(args) {
  if (args.includes('--help')) return { help: true };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!['--port', '--origin', '--cutoff'].includes(key) || !value || Object.hasOwn(options, key)) throw new Error('Invalid probe options; use --help');
    options[key] = value;
  }
  const port = Number(options['--port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid debug port is required');
  let url;
  try { url = new URL(options['--origin']); } catch { throw new Error('An explicit provider origin is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use a provider origin without a path, credentials or query');
  const cutoffDate = options['--cutoff'] ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const timestamp = Date.parse(`${cutoffDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== cutoffDate) throw new Error('Invalid cutoff date');
  return { port, origin: url.origin, cutoffDate };
}

// Kept self-contained for execution in the provider and the page fixture.
export async function readObservedDetailProbe({ origin }) {
  const endpoints = ['/api/v3/aweme/detail/detail/mainPart', '/api/v3/aweme/detail/detail/sumData', '/api/v3/aweme/detail/detail/awemePromotionTrend'];
  const root = document.querySelector('#app')?.__vue__;
  if (location.origin !== origin || root?.$route?.path !== '/video-detail/index') return { error: 'detail-context-mismatch' };
  const awemeId = String(root.$route.query.awemeId ?? '');
  const publicationDate = String(root.$route.query.dateCode ?? '');
  if (!/^\d{1,32}$/.test(awemeId) || !/^\d{8}$/.test(publicationDate)) return { error: 'invalid-detail-identity' };
  const fullPath = root.$route.fullPath;
  const records = [];
  for (const endpoint of endpoints) {
    const observed = performance.getEntriesByType('resource').filter(entry => {
      try {
        const url = new URL(entry.name);
        return url.origin === origin && url.pathname === endpoint && url.searchParams.get('awemeId') === awemeId
          && url.searchParams.get('dateCode') === publicationDate;
      } catch { return false; }
    }).at(-1);
    if (!observed) return { error: 'detail-request-not-observed' };
    const models = Object.values(root.$api?.video || {}).filter(model => model?.url === endpoint && typeof model.GET === 'function');
    if (models.length !== 1) return { error: 'detail-client-not-unique' };
    const params = Object.fromEntries(new URL(observed.name).searchParams);
    if (root.$route.fullPath !== fullPath) return { error: 'detail-context-changed' };
    const raw = await models[0].GET({ params });
    if (root.$route.fullPath !== fullPath) return { error: 'detail-context-changed' };
    const response = { Code: raw?.Code, Status: raw?.Status };
    if (Object.hasOwn(raw || {}, 'ExampleData')) response.ExampleData = true;
    if (endpoint.endsWith('/awemePromotionTrend')) response.Data = Array.isArray(raw?.Data) && raw.Data.length <= 366
      ? raw.Data.map(point => ({ DateCode: point.DateCode, PlayCount: point.PlayCount, IncPlayCount: point.IncPlayCount })) : null;
    else response.Data = { AwemeId: raw?.Data?.AwemeId, DateCode: raw?.Data?.DateCode, PlayCount: raw?.Data?.PlayCount, PlayCountStr: raw?.Data?.PlayCountStr };
    records.push({ request: { method: 'GET', endpoint, params: { awemeId: params.awemeId, dateCode: params.dateCode, promotionId: params.promotionId } }, response });
    if (response.Code === 403) break;
  }
  return { context: { awemeId, publicationDate }, records };
}

async function run(options) {
  const targets = await (await fetch(`http://127.0.0.1:${options.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const matching = targets.filter(target => {
    try { const url = new URL(target.url); return target.type === 'page' && url.origin === options.origin && url.pathname === '/app/' && url.hash.startsWith('#/video-detail/index?'); }
    catch { return false; }
  });
  if (matching.length !== 1) throw new Error('Expected exactly one detail window at the pinned provider origin');
  const debuggerUrl = new URL(matching[0].webSocketDebuggerUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(debuggerUrl.hostname) || Number(debuggerUrl.port) !== options.port) throw new Error('Debug connection must remain on the requested local port');
  const socket = new WebSocket(debuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local debug connection timed out')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Local debug connection failed')); }, { once: true });
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Detail probe timed out')), 30000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error('Detail probe failed'));
        else resolve(message.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: `(${readObservedDetailProbe.toString()})(${JSON.stringify({ origin: options.origin })})`, returnByValue: true, awaitPromise: true,
      } }));
    });
    if (!result || result.error) throw new Error('Observed detail context is unavailable');
    const identity = result.records.find(record => record.request.endpoint.endsWith('/mainPart'));
    const trend = result.records.find(record => record.request.endpoint === FEIGUA_PLAY_PROBE_ENDPOINT);
    const inspected = inspectFeiguaPlayProbe({ context: { ...result.context, cutoffDate: options.cutoffDate }, request: trend?.request, response: trend?.response, identityResponse: identity?.response });
    const { provenance: ignored, ...safe } = inspected;
    return { source: 'detail-page-api', verifiedVideoTotals: 0, result: safe };
  } finally { socket.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseProbeOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else console.log(JSON.stringify(await run(options), null, 2));
  } catch {
    // Transport errors may contain signed URLs; emit only this fixed message.
    console.error('Feigua play-count probe failed. Check --help, the pinned origin, login and current detail window.');
    process.exitCode = 1;
  }
}
