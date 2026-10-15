import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { uploadSubtitleDirect } from '../electron/oss-subtitle-upload.mjs';

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(),'oss-test-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const filePath = path.join(dir,'video.mp4'), bytes = Buffer.alloc(9*1024**2,42); await writeFile(filePath,bytes);
  const id='a'.repeat(48), calls=[], partCalls=[]; let metadata;
  const request=async(stage,body)=>{
    calls.push(stage);
    if(stage==='init') { metadata={upload_id:id,transport:'oss-multipart',size_bytes:bytes.length,sha256:body.sha256,part_size:8*1024**2,part_count:2,completed:false,uploaded_parts:[]}; return metadata; }
    if(stage==='status') return {...metadata,uploaded_parts:[1]};
    if(stage==='part') {partCalls.push(body.part_number);return {upload_id:id,part_number:body.part_number,
      url:'https://aiml-subtitle-temp-20261014.oss-cn-shanghai.aliyuncs.com/aiml-subtitles-temp/'+id+'.mp4?uploadId=synthetic&partNumber='+body.part_number,
      headers:{'content-md5':createHash('md5').update(bytes.subarray(8*1024**2)).digest('base64'),'content-type':'application/octet-stream'}};}
    return {...metadata,completed:true,verified_seconds:5};
  };
  const fetchImpl=async(_url,options)=>new Response(null,{status:200,headers:{etag:createHash('md5').update(options.body).digest('hex')}});
  return {input:{filePath,requestId:'stable-request',request,fetchImpl,...overrides},calls,partCalls,request};
}
test('resuming skips previously verified parts and retains a stable request id',async t=>{
  const f=await fixture(t);const progress=[];
  const r=await uploadSubtitleDirect({...f.input,onProgress:value=>progress.push(value)});
  assert.equal(r.completed,true);assert.deepEqual(f.partCalls,[2]);
  assert.equal(progress[0].resumedParts,1);assert.equal(progress.at(-1).uploadedBytes,9*1024**2);
});
test('part timeout retries same part and never executes paid task',async t=>{
  const f=await fixture(t,{fetchImpl:async()=>{throw new Error('lost response');}});
  await assert.rejects(uploadSubtitleDirect(f.input),{code:'SUBTITLE_UPLOAD_INTERRUPTED'});
  assert.deepEqual(f.partCalls,[2,2,2]);assert.ok(!f.calls.includes('complete'));
});
test('foreign upload destination is rejected before video bytes leave client',async t=>{
  const f=await fixture(t);let sent=false;
  const request=async(stage,body)=>{const r=await f.request(stage,body);return stage==='part'?{...r,url:r.url.replace('oss-cn-shanghai.aliyuncs.com','attacker.invalid')}:r;};
  await assert.rejects(uploadSubtitleDirect({...f.input,request,fetchImpl:async()=>{sent=true;}}),{code:'SUBTITLE_UPLOAD_UNVERIFIED'});
  assert.equal(sent,false);
});
