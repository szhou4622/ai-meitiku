// Explicitly authorized test assets only. No quote, inference or points mutation.
import { app, safeStorage } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { LicenseSecureStore } from '../electron/license-secure-store.mjs';
import { LicenseService } from '../electron/license-service.mjs';
import { createPlatformTransport } from '../electron/platform-transport.mjs';
const [folder,filePath,outputFile] = process.argv.slice(2);
if (!path.isAbsolute(folder || '') || !path.basename(folder).startsWith('aiml-points-preview-')
    || !path.resolve(filePath || '').includes('/artifacts/upload-recovery-20261014/input/')) throw new Error('Isolated test paths required');
app.setName('ai-media-library'); app.setPath('userData',folder);
app.whenReady().then(async()=>{
  try {
    const store=new LicenseSecureStore({userDataPath:folder,safeStorage}), credential=await store.readCredential();
    const service=new LicenseService({secureStore:store,clientVersion:'1.1.24',machineCode:async()=>credential.boundMachineCode || await store.readMachineCode()});
    const before=await service.requestPoints('balance'), original=service.fetchImpl, stats={gatewayRequests:0,gatewayBodyBytes:0,maxGatewayBodyBytes:0,ossPutBytes:0,ossPutRequests:0};
    let interrupt=process.argv.includes('--interrupt-part2'), resumedParts=0, notified=0;
    service.fetchImpl=async(url,options)=>{
      const target=new URL(String(url));
      if (target.hostname.endsWith('.oss-cn-shanghai.aliyuncs.com')) {
        if (options.headers.Authorization || options.headers['X-Device-Credential']) throw new Error('credential destination failed');
        if(interrupt && target.searchParams.get('partNumber')==='2') throw new Error('synthetic interrupted PUT');
        stats.ossPutRequests++;stats.ossPutBytes+=options.body.length;
      } else if(target.pathname.includes('/uploads/subtitle/')) {
        if(typeof options.body!=='string')throw new Error('gateway must receive metadata only');
        const size=Buffer.byteLength(options.body);stats.gatewayRequests++;stats.gatewayBodyBytes+=size;stats.maxGatewayBodyBytes=Math.max(stats.maxGatewayBodyBytes,size);
      }
      return original(url,options);
    };
    const request=createPlatformTransport(service), input={filePath,requestId:'oss-live-20261014:'+path.basename(filePath),onProgress:p=>{
      resumedParts=Math.max(resumedParts,p.resumedParts);
      if(p.uploadedBytes-notified>=128*1024**2 || p.uploadedBytes===p.totalBytes){notified=p.uploadedBytes;console.log(JSON.stringify({uploadedBytes:p.uploadedBytes,totalBytes:p.totalBytes,resumedParts:p.resumedParts}));}
    }};
    const started=Date.now(); let interrupted=false;
    if(interrupt){
      try{await request('subtitle-upload',input);}catch(e){if(e.code!=='SUBTITLE_UPLOAD_INTERRUPTED')throw e;interrupted=true;}
      if(!interrupted)throw new Error('interruption test did not interrupt');
      interrupt=false;
    }
    const result=await request('subtitle-upload',input), after=await service.requestPoints('balance');
    const wallet=x=>({balanceUnits:x.balanceUnits,reservedUnits:x.reservedUnits,availableUnits:x.availableUnits});
    const out={ok:true,transport:'oss-multipart',elapsedSeconds:(Date.now()-started)/1000,interruptedAndResumed:interrupted,resumedParts,
      supplierGenerationRequests:0,quotedTasks:0,before:wallet(before),after:wallet(after),stats,upload:result};
    await writeFile(outputFile,JSON.stringify(out,null,2),{mode:0o600});console.log(JSON.stringify(out));app.quit();
  }catch(e){console.error(JSON.stringify({ok:false,errorCode:e.code||e.kind||e.name}));app.exit(1);}
});
