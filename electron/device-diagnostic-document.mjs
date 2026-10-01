const LINK_PATTERN = /<link\s+rel=["']stylesheet["']\s+href=["']device-diagnostic\.css["']\s*\/?\s*>/i;
const SCRIPT_PATTERN = /<script\s+src=["']device-diagnostic-renderer\.js["']\s*>\s*<\/script>/i;
const CSP_PATTERN = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i;

function escapeInlineScript(source) {
  return String(source || "").replace(/<\/script/gi, "<\\/script");
}

export function buildDeviceDiagnosticDocument({ html, css, renderer }) {
  let document = String(html || "");
  if (!LINK_PATTERN.test(document) || !SCRIPT_PATTERN.test(document)) {
    throw new Error("设备核验页面资源引用不完整");
  }
  if (!CSP_PATTERN.test(document)) {
    throw new Error("设备核验页面缺少内容安全策略");
  }
  document = document.replace(
    CSP_PATTERN,
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">',
  );
  document = document.replace(LINK_PATTERN, `<style>${String(css || "")}</style>`);
  document = document.replace(SCRIPT_PATTERN, `<script>${escapeInlineScript(renderer)}</script>`);
  return document;
}
