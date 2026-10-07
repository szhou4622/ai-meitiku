import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FeiguaLoginCredentialStore, normalizeLoginCredentials, FEIGUA_LOGIN_CREDENTIAL_FILE } from '../electron/feigua-login-credentials.mjs';
import { FeiguaBrowser } from '../electron/feigua-browser.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';

const entry = 'https://portal.example/login';
const credentials = {username:'synthetic-user',password:'synthetic-password'};

function vault() {
  let ciphertext=null, failed=false;
  const writes=[];
  return {writes,setFailure:value=>{failed=value;},ciphertext:()=>ciphertext,
    store:new FeiguaLoginCredentialStore({secureStore:{
      readEncrypted:async name=>{assert.equal(name,FEIGUA_LOGIN_CREDENTIAL_FILE);return ciphertext&&Buffer.from(ciphertext,'base64').toString('utf8');},
      writeEncrypted:async(name,value)=>{assert.equal(name,FEIGUA_LOGIN_CREDENTIAL_FILE);if(failed)throw new Error('Synthetic encryption unavailable');writes.push(name);ciphertext=Buffer.from(value).toString('base64');},
    }}),
  };
}

test('saved credentials use only the encrypted store and are bound to the exact configured entry',async()=>{
  const v=vault();
  assert.equal(await v.store.read(entry),null);
  await v.store.write(entry,credentials);
  assert.deepEqual(await v.store.read(entry),credentials);
  for(const other of ['https://portal.example/new-login','http://portal.example/login','https://portal.example:444/login','https://other.example/login'])assert.equal(await v.store.read(other),null);
  assert.equal(v.ciphertext().includes(credentials.password),false);
  assert.deepEqual(v.writes,[FEIGUA_LOGIN_CREDENTIAL_FILE]);
});

test('updates replace the previous password, unchecking remember removes the credential payload, and write errors preserve it',async()=>{
  const v=vault();
  await v.store.write(entry,credentials);
  await v.store.write(entry,{...credentials,password:'synthetic-new-password'});
  assert.equal((await v.store.read(entry)).password,'synthetic-new-password');
  const previous=v.ciphertext();v.setFailure(true);
  await assert.rejects(v.store.write(entry,credentials),/unavailable/);
  assert.equal(v.ciphertext(),previous);
  v.setFailure(false);await v.store.write(entry,null);
  assert.equal(await v.store.read(entry),null);
  const tombstone=JSON.parse(Buffer.from(v.ciphertext(),'base64').toString('utf8'));
  assert.equal(Object.hasOwn(tombstone,'password'),false);
  assert.equal(Object.hasOwn(tombstone,'username'),false);
});

test('invalid inputs and corrupted encrypted payloads are rejected without exposing secret values',async()=>{
  for(const value of [{username:'',password:'x'},{username:'x',password:''},{username:'x',password:'x'.repeat(4097)},{username:'x',password:'x\0'}])assert.equal(normalizeLoginCredentials(value),null);
  const store=new FeiguaLoginCredentialStore({secureStore:{readEncrypted:async()=>`broken:${credentials.password}`}});
  await assert.rejects(store.read(entry),error=>!error.message.includes(credentials.password)&&/原加密文件已保留/.test(error.message));
});

test('private credential messages require the owned portal main frame and ignore stale snapshots',async()=>{
  const ipcMain=new EventEmitter(),writes=[];
  const browser=new FeiguaBrowser({ipcMain,credentialStore:{write:async(url,value)=>writes.push([url,value])}});
  browser.setLoginEntryUrl(entry);
  const frame={url:entry};
  browser.window={isDestroyed:()=>false,webContents:{id:123,mainFrame:frame}};
  browser.credentialContext={entryUrl:entry,windowId:123,lastSequence:0};
  const payload={sequence:1,remember:true,credentials};
  for(const event of [{sender:{},senderFrame:frame},{sender:browser.window.webContents,senderFrame:{url:entry}},{sender:browser.window.webContents,senderFrame:null}]){
    ipcMain.emit('feigua-private-login-memory',event,payload);assert.equal(event.returnValue,false);
  }
  frame.url='https://other.example/login';
  const wrongOrigin={sender:browser.window.webContents,senderFrame:frame};
  ipcMain.emit('feigua-private-login-memory',wrongOrigin,payload);assert.equal(wrongOrigin.returnValue,false);
  frame.url=entry;
  const valid={sender:browser.window.webContents,senderFrame:frame};
  ipcMain.emit('feigua-private-login-memory',valid,payload);assert.equal(valid.returnValue,true);
  ipcMain.emit('feigua-private-login-memory',valid,payload);assert.equal(valid.returnValue,false);
  await new Promise(r=>setImmediate(r));assert.deepEqual(writes,[[entry,credentials]]);
  browser.credentialContext=null;ipcMain.emit('feigua-private-login-memory',valid,{...payload,sequence:2});assert.equal(valid.returnValue,false);
});

test('credential autofill runs in an isolated world for the configured portal and never reaches the public state',async()=>{
  const writes=[],worlds=[];
  const browser=new FeiguaBrowser({credentialStore:{read:async()=>credentials,write:async(url,value)=>writes.push([url,value])}});
  browser.setLoginEntryUrl(entry);
  browser.window={isDestroyed:()=>false,webContents:{id:123,getURL:()=>entry,executeJavaScriptInIsolatedWorld:async(id,scripts)=>{
    worlds.push(id);return scripts[0].code.includes('"command":"install"')?{installed:true,remember:true}:{installed:true,remember:true,credentials,sequence:1};
  }}};
  await browser.installCredentialMemory(browser.window);
  await new Promise(r=>setTimeout(r,10));
  browser.stopCredentialMemory();
  assert.deepEqual(writes[0],[entry,credentials]);
  assert.ok(worlds.every(id=>id===47));
  const state=new FeiguaService({userDataPath:'/unused',browser,storage:{read:async()=>({version:1,loginEntryUrl:entry,keywords:[],runs:[]}),write:async()=>{}}});
  assert.equal(JSON.stringify(await state.state()).includes(credentials.password),false);
  assert.equal(JSON.stringify(await state.state()).includes(credentials.username),false);
  browser.window.webContents.getURL=()=> 'https://other.example/login';
  const before=worlds.length;
  await browser.installCredentialMemory(browser.window);
  assert.equal(worlds.length,before);
});
