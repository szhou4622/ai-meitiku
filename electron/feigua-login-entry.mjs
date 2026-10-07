export function normalizeLoginEntryUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value.trim())) throw new Error('请输入有效的登录入口网址');
  if (!value.trim()) return '';
  if (!/^https?:\/\//i.test(value.trim())) throw new Error('登录入口网址需以 http:// 或 https:// 开头');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('登录入口网址需以 http:// 或 https:// 开头'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('登录入口仅支持 HTTP / HTTPS 网址，请勿在网址中填写账号密码');
  return url.href;
}

export function isLoginEntryNavigation(value, entryUrl) {
  if (!entryUrl) return false;
  try { return new URL(normalizeLoginEntryUrl(value)).origin === new URL(normalizeLoginEntryUrl(entryUrl)).origin; }
  catch { return false; }
}
