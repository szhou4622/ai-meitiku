// This endpoint is product-scoped. Its PlayCount is a candidate metric, never
// a verified total video play count and never a replacement for row.plays.
export const FEIGUA_PLAY_PROBE_ENDPOINT = '/api/v3/aweme/detail/detail/awemePromotionTrend';

function dateCode(value) {
  const code = String(value ?? '').replaceAll('-', '');
  if (!/^\d{8}$/.test(code)) return null;
  const iso = `${code.slice(0, 4)}-${code.slice(4, 6)}-${code.slice(6, 8)}`;
  const timestamp = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso ? code : null;
}

const count = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const identifier = value => typeof value === 'string' && /^\d{1,32}$/.test(value);

export function inspectFeiguaPlayProbe({ context, request, response, identityResponse }) {
  const unavailable = reason => ({ status: 'unavailable', reason, verifiedAsVideoTotal: false });
  if (!identifier(context?.awemeId) || !dateCode(context?.publicationDate) || !dateCode(context?.cutoffDate)
    || dateCode(context.publicationDate) > dateCode(context.cutoffDate)) return unavailable('invalid-context');
  if (request?.method !== 'GET' || request.endpoint !== FEIGUA_PLAY_PROBE_ENDPOINT
    || request.params?.awemeId !== context.awemeId || !identifier(request.params?.promotionId)
    || dateCode(request.params?.dateCode) !== dateCode(context.publicationDate)) return unavailable('request-mismatch');
  if (identityResponse?.Code !== 200 || identityResponse.Status !== true
    || String(identityResponse.Data?.AwemeId) !== context.awemeId
    || dateCode(identityResponse.Data?.DateCode) !== dateCode(context.publicationDate)) return unavailable('identity-mismatch');
  if (response?.Code !== 200 || response.Status !== true || Object.hasOwn(response, 'ExampleData')
    || !Array.isArray(response.Data) || !response.Data.length || response.Data.length > 366) return unavailable('invalid-response');
  const dates = new Set();
  const points = [];
  for (const point of response.Data) {
    const date = dateCode(point?.DateCode);
    if (!date || dates.has(date) || date < dateCode(context.publicationDate)
      || date > dateCode(context.cutoffDate)) return unavailable('invalid-dates');
    dates.add(date);
    points.push({ date, plays: count(point.PlayCount), increment: count(point.IncPlayCount) });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  const latest = points.at(-1);
  if (latest.plays === null || latest.plays === 0 || latest.increment === null
    || points.length > 1 && points.at(-2).plays !== null && latest.plays < points.at(-2).plays) return unavailable('latest-point-unreliable');
  return {
    status: 'candidate', verifiedAsVideoTotal: false, scope: 'promotion-trend',
    candidatePlayCount: String(latest.plays), asOfDate: `${latest.date.slice(0, 4)}-${latest.date.slice(4, 6)}-${latest.date.slice(6, 8)}`,
    provenance: { endpoint: FEIGUA_PLAY_PROBE_ENDPOINT, awemeId: context.awemeId, promotionId: request.params.promotionId, responseCode: 200 },
  };
}
