// Retrieves an already accepted test task. Never quotes or runs an inference.
import { app, safeStorage } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LicenseSecureStore } from '../electron/license-secure-store.mjs';
import { LicenseService } from '../electron/license-service.mjs';
import { createPlatformTransport } from '../electron/platform-transport.mjs';
import { downloadAliyunResult, probeVideo } from '../electron/aliyun-subtitle-client.mjs';
const [folder,quoteId,output,receipt] = process.argv.slice(2);
if (!path.basename(folder || '').startsWith('aiml-points-preview-') || !/^[a-f0-9]{40}$/.test(quoteId || '')
    || !path.isAbsolute(output || '') || !output.includes('/artifacts/oss-direct-20261014/')) throw new Error('Test output paths required');
app.setName('ai-media-library'); app.setPath('userData',folder);
app.whenReady().then(async()=>{try{
  const store=new LicenseSecureStore({userDataPath:folder,safeStorage}), credential=await store.readCredential();
  const service=new LicenseService({secureStore:store,clientVersion:'1.1.24',machineCode:async()=>credential.boundMachineCode || await store.readMachineCode()});
  const status=await createPlatformTransport(service)('status',{quote_id:quoteId});
  if (status.status !== 'succeeded' || !status.result?.VideoUrl) throw Object.assign(new Error('Task pending'),{code:'EXISTING_TASK_PENDING'});
  const started=Date.now();
  const file=await downloadAliyunResult(status.result.VideoUrl,output,{probe:p=>probeVideo(p,'/Users/a1-6/.local/bin/ffmpeg',{input:false}),signal:AbortSignal.timeout(120000)});
  const result={ok:true,quoteId,pointsUsed:status.points_used,usage:status.result.usage,downloadSaveSeconds:(Date.now()-started)/1000,completedAt:new Date().toISOString(),file};
  await writeFile(receipt,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));app.quit();
}catch(e){console.error(JSON.stringify({ok:false,errorCode:e.code||e.kind||e.name}));app.exit(1);}});
