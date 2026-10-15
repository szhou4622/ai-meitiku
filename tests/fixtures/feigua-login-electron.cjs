/* eslint @typescript-eslint/no-require-imports: "off" -- Electron launches this standalone CommonJS test entry. */
const { app, BrowserWindow, session } = require('electron');
const assert=require('node:assert/strict'); const {pathToFileURL}=require('node:url'); const http=require('node:http'); const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');
app.on('window-all-closed', () => {});
const data=fs.mkdtempSync(path.join(os.tmpdir(),'feigua-flow-readonly-')); app.setPath('userData',data);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let portal,gateway;
(async()=>{
 const {FeiguaBrowser}=await import(pathToFileURL(path.resolve(__dirname, '../../electron/feigua-browser.mjs')).href);
 gateway=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<html><body>个人中心 收藏夹 视频/素材</body></html>');});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));const target='http://127.0.0.1:'+gateway.address().port+'/app/';
 portal=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:target});res.end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<html><body>synthetic portal</body></html>');});
 await new Promise(r=>portal.listen(0,'127.0.0.1',r));const entry='http://127.0.0.1:'+portal.address().port+'/';
 await app.whenReady();
 for(const mode of ['direct-navigation','server-redirect','direct-popup','blank-popup']){
  const browser=new FeiguaBrowser({BrowserWindow,session});browser.setLoginEntryUrl(entry);const w=browser.ensureWindow(false);await w.loadURL(entry);
  const traces=[];w.webContents.on('will-navigate',(_e,url)=>traces.push({event:'will-navigate',destination:url.startsWith(target)?'gateway':'portal'}));
  w.webContents.on('will-redirect',(_e,url)=>traces.push({event:'will-redirect',destination:url.startsWith(target)?'gateway':'portal'}));
  let result;
  if(mode==='direct-navigation') result=await w.webContents.executeJavaScript('location.href='+JSON.stringify(target)+'; true',true);
  if(mode==='server-redirect') result=await w.webContents.executeJavaScript('location.href='+JSON.stringify(entry+'redirect')+'; true',true);
  if(mode==='direct-popup') result=await w.webContents.executeJavaScript('(()=>{const p=window.open('+JSON.stringify(target)+',"_blank");return {popupNull:p===null};})()',true).catch(()=>({contextDestroyed:true}));
  if(mode==='blank-popup') result=await w.webContents.executeJavaScript('(()=>{const p=window.open("","_blank");if(p)p.location.href='+JSON.stringify(target)+';return {popupNull:p===null};})()',true);
  await wait(800); assert.ok(browser.window.webContents.getURL().startsWith(target)); if(mode.includes('popup')) assert.equal(result.popupNull,false); const auth=await browser.checkLogin(); assert.equal(auth.status,'authenticated'); assert.equal(browser.sourceOrigin(),new URL(target).origin); const prefs=browser.window.webContents.getLastWebPreferences(); assert.equal(prefs.nodeIntegration,false); assert.equal(prefs.sandbox,true); assert.equal(prefs.contextIsolation,true); console.log(JSON.stringify({mode,enteredGateway:browser.window.webContents.getURL().startsWith(target),result,traces}));let signedIn=false;browser.onAuthChange=auth=>{if(auth.status==='authenticated')signedIn=true;};browser.startLoginWatch();await wait(150);assert.equal(signedIn,true);assert.equal(browser.loginWindows.size,0);assert.equal(browser.window,null);browser.dispose();
 }
 gateway.close();portal.close();console.log('ISOLATED_SYNTHETIC_ELECTRON_COMPLETE');app.quit();
})().catch(e=>{console.error(e.message);gateway?.close();portal?.close();app.exit(1);});
