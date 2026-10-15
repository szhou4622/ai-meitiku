const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'feigua-channel-test-')));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const entry = 'http://121.40.180.3/';
const target = 'http://sdy.73le.com/app/';
let proxy;
(async () => {
  const { FeiguaBrowser } = await import(pathToFileURL(path.resolve(__dirname, '../../electron/feigua-browser.mjs')).href);
  // Isolated HTTP proxy serves fixtures under the observed origins. This test
  // never contacts the portal/provider or reuses the user's login session.
  proxy = http.createServer((req, res) => {
    const url = new URL(req.url);
    if (url.origin === new URL(entry).origin && url.pathname === '/redirect') {
      res.writeHead(302, { Location: target }); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(url.origin === new URL(target).origin ? '<html><body>个人中心 收藏夹 视频/素材</body></html>' : '<html><body>synthetic login portal</body></html>');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  await session.fromPartition('persist:feigua-trends').setProxy({ proxyRules: `http=127.0.0.1:${proxy.address().port}` });
  for (const mode of ['navigation', 'redirect', 'popup', 'blank-popup']) {
    const browser = new FeiguaBrowser({ BrowserWindow, session }); browser.setLoginEntryUrl(entry);
    const parent = browser.ensureWindow(false); await parent.loadURL(entry);
    let popup;
    if (mode === 'navigation' || mode === 'redirect') await parent.webContents.executeJavaScript(`location.href=${JSON.stringify(mode === 'redirect' ? entry + 'redirect' : target)}; true`, true);
    else popup = await parent.webContents.executeJavaScript(`(() => { const p=window.open(${JSON.stringify(mode === 'blank-popup' ? '' : target)}, '_blank'); ${mode === 'blank-popup' ? `if(p)p.location.href=${JSON.stringify(target)};` : ''} return p !== null; })()`, true);
    for (let i=0;i<60 && !browser.window.webContents.getURL().startsWith(target);i++) await wait(100);
    assert.ok(browser.window.webContents.getURL().startsWith(target));
    if (mode.includes('popup')) assert.equal(popup, true);
    assert.equal(browser.window.isVisible(), false);
    assert.equal((await browser.checkLogin()).status, 'authenticated');
    assert.equal(browser.sourceOrigin(), 'http://sdy.73le.com');
    browser.dispose(); console.log(JSON.stringify({ mode, enteredVerifiedGateway:true, hidden:true }));
  }
  const browser = new FeiguaBrowser({ BrowserWindow, session }); browser.setLoginEntryUrl(entry);
  const parent = browser.ensureWindow(false); await parent.loadURL(entry);
  let auth; browser.onAuthChange = value => { auth = value; };
  await parent.webContents.executeJavaScript(`(() => { const p=window.open('', '_blank');p.location.href='http://unrelated.example/app/?token=synthetic-private';return p !== null; })()`, true);
  const child = browser.window;
  let body=''; for (let i=0;i<60;i++) { body=await child.webContents.executeJavaScript('document.body.innerText'); if(body.includes('关闭窗口，返回登录入口')) break; await wait(100); }
  assert.match(body, /登录通道未打开/); assert.match(body, /http:\/\/unrelated\.example/);
  assert.doesNotMatch(body, /synthetic-private/); assert.equal(auth.status,'error'); assert.equal(child.isVisible(),false);
  await child.webContents.executeJavaScript('document.querySelector("button").click()'); await wait(200);
  assert.equal(browser.window,parent); browser.dispose();
  console.log(JSON.stringify({ mode:'blocked-blank-popup', visibleError:true, returnedToPortal:true, noSignedUrl:true, hidden:true }));
  proxy.close(); app.exit(0);
})().catch(error => { console.error(error.message); proxy?.close(); app.exit(1); });
