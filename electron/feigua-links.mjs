// Only observed public destinations are supported. Never send gateway session
// URLs, signed media downloads, custom protocols, or credentials to the browser.
export function feiguaVideoLink(value, videoId) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/(?:share\/)?video\/(\d{6,25})\/?$/);
    if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password || !match || match[1] !== String(videoId)) return null;
    return `https://www.douyin.com/video/${match[1]}`;
  } catch { return null; }
}

export function feiguaProductLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'haohuo.jinritemai.com' || url.port || url.username || url.password || url.pathname !== '/ecommerce/trade/detail/index.html' || url.hash) return null;
    if (url.searchParams.getAll('id').length !== 1 || !/^\d{6,25}$/.test(url.searchParams.get('id'))) return null;
    if ([...url.searchParams.keys()].some(key => !['id', 'origin_type'].includes(key)) || url.searchParams.getAll('origin_type').length > 1) return null;
    if (url.searchParams.has('origin_type') && !/^\d{1,8}$/.test(url.searchParams.get('origin_type'))) return null;
    return url.href;
  } catch { return null; }
}
