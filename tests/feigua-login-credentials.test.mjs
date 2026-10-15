import test from 'node:test';
import assert from 'node:assert/strict';
import { FeiguaLoginCredentialStore, normalizeLoginCredentials, FEIGUA_LOGIN_CREDENTIAL_FILE } from '../electron/feigua-login-credentials.mjs';

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
