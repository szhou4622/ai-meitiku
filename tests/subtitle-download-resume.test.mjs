import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadAliyunResult } from '../electron/aliyun-subtitle-client.mjs';

test('retained result resumes after disconnect and refreshed URL; checksum guards final rename',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'subtitle-range-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'output.mp4'),bytes=Buffer.from('complete retained video');
 const options={expectedSize:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),probe:async()=>{}};
 let reads=0;
 await assert.rejects(downloadAliyunResult('https://test.aliyuncs.com/old',file,{...options,fetchImpl:async()=>new Response(new ReadableStream({pull(controller){if(reads++===0)controller.enqueue(bytes.subarray(0,5));else controller.error(new Error('disconnected'));}}))}));
 // Stream buffering can fail before any chunk reaches disk; create a deterministic persisted prefix.
 const {writeFile}=await import('node:fs/promises');await writeFile(file+'.download.part.mp4',bytes.subarray(0,5));
 let requestedRange;
 await downloadAliyunResult('https://test.aliyuncs.com/fresh',file,{...options,fetchImpl:async(_url,input)=>{requestedRange=input.headers.Range;return new Response(bytes.subarray(5),{status:206,headers:{'content-range':`bytes 5-${bytes.length-1}/${bytes.length}`}});}});
 assert.equal(requestedRange,'bytes=5-');assert.deepEqual(await readFile(file),bytes);
 await assert.rejects(stat(file+'.download.part.mp4'),{code:'ENOENT'});
});

test('invalid resumed bytes never overwrite the final output',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'subtitle-hash-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'output.mp4');
 await assert.rejects(downloadAliyunResult('https://test.aliyuncs.com/result',file,{expectedSize:3,expectedSha256:'a'.repeat(64),probe:async()=>{},fetchImpl:async()=>new Response('bad')}),/校验失败/);
 await assert.rejects(stat(file),{code:'ENOENT'});
 await assert.rejects(stat(file+'.download.part.mp4'),{code:'ENOENT'});
});
