import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { customerProfiles, loadCustomerProfiles, cleanLegacyRuntimeCredentials } from "../electron/customer-api-profiles.mjs";
import { buildClassifierRuntimeEnvironment } from "../electron/classifier-user-config.mjs";
import { verifyCredentialTree, inspectCredentialText } from "../scripts/installer-credentials.mjs";

test("fresh install ignores ambient and package credentials, but saved user configuration survives restart", async () => {
  let raw = null, writes = 0;
  const store = { readEncrypted: async () => raw, writeEncrypted: async (_, value) => { raw = value; writes++; } };
  const fresh = await loadCustomerProfiles(store);
  assert.equal(fresh.volcengine.apiKey, ""); assert.equal(fresh.volcengine.endpointId, ""); assert.equal(writes, 0);
  const env = buildClassifierRuntimeEnvironment({ ARK_API_KEY: "ambient-secret", PATH: "kept" }, fresh, "volcengine");
  assert.equal(env.ARK_API_KEY, undefined); assert.equal(env.PATH, "kept");
  raw = JSON.stringify({ provider: "relay", volcengine: { apiKey: "user-key", endpointId: "ep-user" }, relay: { apiKey: "user-relay-key", textModel: "my-model" } });
  for (let i = 0; i < 2; i++) {
    const loaded = await loadCustomerProfiles(store);
    assert.equal(loaded.volcengine.apiKey, "user-key"); assert.equal(loaded.volcengine.endpointId, "ep-user");
    assert.equal(loaded.relay.apiKey, "user-relay-key"); assert.equal(loaded.provider, "relay");
  }
  assert.equal(writes, 0);
});

test("incident cleanup removes only matched keys and their defaults from both provider profiles", () => {
  const check = { isLeakedKey: key => key === "synthetic-compromised", isLeakedId: id => id === "ep-incident" };
  const original = { volcengine: { apiKey: "synthetic-compromised", endpointId: "ep-incident" },
    relay: { apiKey: "personal-relay", textModel: "ep-incident", baseUrl: "https://example.test" } };
  const { profiles, removed } = customerProfiles(original, check);
  assert.equal(removed, true); assert.equal(profiles.volcengine.apiKey, ""); assert.equal(profiles.volcengine.endpointId, "");
  assert.equal(profiles.relay.apiKey, "personal-relay"); assert.equal(profiles.relay.textModel, "ep-incident");
  assert.equal(original.volcengine.apiKey, "synthetic-compromised");
  assert.equal(customerProfiles(profiles, check).removed, false);
  const relay = customerProfiles({ relay: { apiKey: "synthetic-compromised", textModel: "custom-model" } }, check);
  assert.equal(relay.profiles.relay.apiKey, ""); assert.equal(relay.profiles.relay.textModel, "custom-model");
});

test("historical env cleanup preserves unrelated user credentials and is idempotent", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "credential-cleanup-")); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".env.local");
  await writeFile(file, 'ARK_API_KEY="synthetic-compromised"\nUSER_KEY=personal-key\n# comment\n');
  const options = { isLeakedKey: key => key === "synthetic-compromised" };
  await cleanLegacyRuntimeCredentials(root, options); await cleanLegacyRuntimeCredentials(root, options);
  const text = await readFile(file, "utf8"); assert.doesNotMatch(text, /synthetic-compromised/); assert.match(text, /USER_KEY=personal-key/);
});

test("packaging gate rejects nested env, user credential JSON and personal endpoints", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "installer-gate-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), "ARK_API_KEY=synthetic-only");
  await assert.rejects(verifyCredentialTree(root), /禁止携带/);
  assert.throws(() => inspectCredentialText('{"apiKey":"synthetic-only"}', "config.json"), /凭证/);
  assert.throws(() => inspectCredentialText('{"vision_model":{"model":"ep-personal"}}', "settings.json"), /个人接入点/);
  inspectCredentialText('{"vision_model":{"model":""},"apiKey":""}', "settings.json");
});
