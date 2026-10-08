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

// Feigua's public blogger view uses DouyinBloggerUrl and a UID-based QR link.
// A display name or Feigua's internal blogger ID cannot identify a profile.
export function feiguaAuthorLink(value, uid = null) {
  const identity = typeof uid === 'string' ? uid : Number.isSafeInteger(uid) ? String(uid) : '';
  const authorUid = /^\d{6,25}$/.test(identity) ? identity : null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password) {
      const profile = url.pathname.match(/^\/user\/(MS4wLjAB[A-Za-z0-9_-]{4,192})\/?$/);
      if (url.hostname === 'www.douyin.com' && profile) return `https://www.douyin.com/user/${profile[1]}`;
      const shared = url.pathname.match(/^\/share\/user\/(\d{6,25})\/?$/);
      if (url.hostname === 'www.iesdouyin.com' && shared && (!authorUid || shared[1] === authorUid)) return `https://www.iesdouyin.com/share/user/${shared[1]}`;
    }
  } catch { /* A source UID can still supply the public share page. */ }
  return authorUid ? `https://www.iesdouyin.com/share/user/${authorUid}` : null;
}
