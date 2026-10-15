// Authorized boundary upload only: no quotation, reservation or inference.
import { app, safeStorage } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { LicenseSecureStore } from '../electron/license-secure-store.mjs';
import { LicenseService } from '../electron/license-service.mjs';
import { createPlatformTransport } from '../electron/platform-transport.mjs';
const [folder,filePath,outputFile]=process.argv.slice(2);
if(!folder||!path.isAbsolute(folder)||!path.basename(folder).startsWith('aiml-points-preview-')||!filePath||!outputFile)throw new Error('Isolated verification paths required');
app.setName('ai-media-library');app.setPath('userData',folder);
app.whenReady().then(async()=>{
 try{
  const store=new LicenseSecureStore({userDataPath:folder,safeStorage});const credential=await store.readCredential();
  const service=new LicenseService({secureStore:store,clientVersion:'1.1.24',machineCode:async()=>credential.boundMachineCode||await store.readMachineCode()});
  const before=await service.requestPoints('balance');const fetchImpl=service.fetchImpl;
  service.fetchImpl=async(url,options)=>{
   if(!String(url).endsWith('/uploads/subtitle'))return fetchImpl(url,options);
   const original=options.body;let bytes=0,last=0;
   async function* progress(){for await(const chunk of original){bytes+=chunk.length;if(bytes-last>=128*1024**2){console.log(JSON.stringify({uploaded_bytes:bytes}));last=bytes;}yield chunk;}}
   return fetchImpl(url,{...options,body:progress()});
  };
  const result=await createPlatformTransport(service)('subtitle-upload',{filePath});const after=await service.requestPoints('balance');
  const wallet=x=>({balanceUnits:x.balanceUnits,reservedUnits:x.reservedUnits,availableUnits:x.availableUnits});
  const out={ok:true,appName:'ai-media-library',supplierGenerationRequests:0,quotedTasks:0,before:wallet(before),after:wallet(after),upload:result};
  await writeFile(outputFile,JSON.stringify(out,null,2),{mode:0o600});console.log(JSON.stringify({ok:true,sizeBytes:result.size_bytes,before:out.before,after:out.after}));app.quit();
 }catch(error){console.error(JSON.stringify({ok:false,errorCode:error.code||error.kind||error.name}));app.exit(1);}
});
