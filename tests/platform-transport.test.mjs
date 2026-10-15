import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPlatformTransport, platformFeatureStatus } from "../electron/platform-transport.mjs";

function fixture(fetchImpl, changes = {}) {
  return {
    config: { appName: "ai-media-library", baseUrl: "http://127.0.0.1:43899/api/license" },
    secureStore: { readCredential: async () => ({ codeId: "synthetic-account", deviceCredential: "synthetic-proof", deviceSession: "synthetic-session" }) },
    credentialHeaders: credential => ({ Authorization: `Bearer ${credential.deviceSession}`, "X-Device-Credential": credential.deviceCredential }),
    refreshDeviceSession: async credential => ({ ok: true, credential: { ...credential, deviceSession: "synthetic-restored-session" } }),
    fetchImpl, ...changes,
  };
}
const response = (status, body) => new Response(JSON.stringify(body), { status });

test('subtitle upload sends only metadata to gateway and binary only to scoped OSS', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'subtitle-direct-')); t.after(() => rm(dir, {recursive:true,force:true}));
  const filePath = path.join(dir, 'video.mp4'); const bytes = Buffer.alloc(3 * 1024 ** 2, 42); await writeFile(filePath, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex'), md5 = createHash('md5').update(bytes).digest('hex');
  const id = 'a'.repeat(48); let binaryCalls = 0;
  const metadata = {ok:true,app_name:'ai-media-library',transport:'oss-multipart',upload_id:id,
    size_bytes:bytes.length,sha256:sha,part_size:8*1024**2,part_count:1,uploaded_parts:[],completed:false};
  const request = createPlatformTransport(fixture(async (url, options) => {
    if (String(url).includes('.oss-cn-shanghai.aliyuncs.com/')) {
      binaryCalls++; assert.equal(options.headers.Authorization,undefined); assert.equal(options.headers['X-Device-Credential'],undefined);
      assert.deepEqual(options.body,bytes); assert.equal(options.headers['content-md5'],Buffer.from(md5,'hex').toString('base64'));
      return new Response(null,{status:200,headers:{etag:'"'+md5+'"'}});
    }
    assert.equal(typeof options.body,'string'); assert.doesNotMatch(options.body,/video\.mp4|synthetic-proof/);
    const body = JSON.parse(options.body);
    if (url.endsWith('/init')) { assert.deepEqual(body.part_md5,[md5]); return response(200,metadata); }
    if (url.endsWith('/status')) return response(200,metadata);
    if (url.endsWith('/part')) return response(200,{ok:true,app_name:'ai-media-library',upload_id:id,part_number:1,
      url:'https://aiml-subtitle-temp-20261014.oss-cn-shanghai.aliyuncs.com/aiml-subtitles-temp/'+id+'.mp4?uploadId=synthetic&partNumber=1',
      headers:{'content-type':'application/octet-stream','content-md5':Buffer.from(md5,'hex').toString('base64')}});
    if (url.endsWith('/complete')) return response(200,{...metadata,completed:true,verified_seconds:5});
    throw new Error('unexpected endpoint');
  }));
  assert.equal((await request('subtitle-upload',{filePath})).upload_id,id); assert.equal(binaryCalls,1);
  await assert.rejects(request('subtitle-upload',{filePath,cost_cny:'0'}),{code:'INVALID_PLATFORM_REQUEST'});
});

test("capabilities require both live switches and explicit feature availability", async () => {
  const body = { ok: true, app_name: "ai-media-library", generation_enabled: true, consumption_enabled: true,
    providers: { volcengine: { configured: true } }, enabled_features: ["prompt-library"] };
  const service = fixture(async url => {
    assert.equal(url, "http://127.0.0.1:43899/api/ai-media-library/v1/capabilities");
    return response(200, body);
  });
  assert.equal((await platformFeatureStatus(service, "prompt-library", "volcengine")).ready, true);
  assert.equal((await platformFeatureStatus(service, "classifier", "volcengine")).ready, false);
  body.generation_enabled = false;
  assert.equal((await platformFeatureStatus(service, "prompt-library", "volcengine")).ready, false);
  body.generation_enabled = true; delete body.enabled_features;
  assert.equal((await platformFeatureStatus(service, "prompt-library", "volcengine")).ready, false);
});

test("missing quote endpoint reports unavailable without suggesting a nonexistent task", async () => {
  const request = createPlatformTransport(fixture(async () => new Response("not found", { status: 404 })));
  await assert.rejects(request("quote", {}), error => error.code === "PLATFORM_API_UNAVAILABLE" && /未提交任务，也未扣积分/.test(error.message));
});

test("platform transport fixes app scope, limits endpoints and keeps device proof out of the body", async () => {
  const service = fixture(async (url, options) => {
    assert.equal(url, "http://127.0.0.1:43899/api/ai-media-library/v1/tasks/quote");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic-session");
    const payload = JSON.parse(options.body);
    assert.equal(payload.app_name, "ai-media-library");
    assert.doesNotMatch(options.body, /synthetic-proof|Settlement-Token|apiKey/);
    return response(200, { ok: true, app_name: "ai-media-library" });
  });
  const request = createPlatformTransport(service);
  await request("quote", { feature: "schemes" });
  await assert.rejects(request("internal/commit", {}), { code: "APP_SCOPE_MISMATCH" });
  for (const field of ["budget_cny", "max_points", "cost_cny", "app_name"])
    await assert.rejects(request("quote", { [field]: "0" }), { code: "INVALID_PLATFORM_REQUEST" });
});

test("a confirmed 401 refreshes existing proof and retries the identical task once", async () => {
  const calls = [];
  const request = createPlatformTransport(fixture(async (_url, options) => {
    calls.push(options);
    return calls.length === 1 ? response(401, { ok: false }) : response(200, { ok: true, app_name: "ai-media-library" });
  }));
  await request("run", { quote_id: "a".repeat(40), confirm_run: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[1].headers.Authorization, "Bearer synthetic-restored-session");
});

test("a timeout is classified for status recovery and does not automatically resubmit", async () => {
  let calls = 0;
  const request = createPlatformTransport(fixture(async () => { calls++; throw new Error("synthetic"); }));
  await assert.rejects(request("run", { quote_id: "a".repeat(40), confirm_run: true }), { kind: "network" });
  assert.equal(calls, 1);
});

test("foreign app results and changed account proof cannot authorize execution", async () => {
  const foreign = createPlatformTransport(fixture(async () => response(200, { ok: true, app_name: "foreign" })));
  await assert.rejects(foreign("quote", {}), { code: "PLATFORM_REQUEST_FAILED" });
  const changed = createPlatformTransport(fixture(async () => response(401, { ok: false }), {
    refreshDeviceSession: async () => ({ ok: true, credential: { codeId: "another-account", deviceSession: "session", deviceCredential: "proof" } }),
  }));
  await assert.rejects(changed("run", { quote_id: "a".repeat(40), confirm_run: true }), { code: "DEVICE_CHANGED" });
});
