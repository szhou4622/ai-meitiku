import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoverReverseVideoOutput, mergeRepairedReverse } from '../electron/prompt-partial.mjs';
import { reverseMedia } from '../electron/prompt-reverse.mjs';
import { createPromptLibraryService } from '../electron/prompt-library-service.mjs';
import { createGeneratedResults } from '../electron/generated-results.mjs';
import { requestClassifierText } from '../electron/classifier-text-client.mjs';
import { recoverClassifierDraft } from '../electron/classifier-draft.mjs';
import { generateReplacement } from '../electron/prompt-replacement.mjs';

const six = (text, length = 1) => `【主体】${text}\n【风格】写实\n【光影】顶部柔光\n【时间线】\n0–${length}s 动作\n【BGM】无音乐\n【限制】保持身份`;
const good = { full: six('整片已有结果', 3), shots: [0, 1, 2].map(index => ({ start: index, end: index + 1, prompt: six(`第${index + 1}镜已有结果`) })) };
const bad = { ...good, shots: good.shots.map((shot, index) => index === 1 ? { ...shot, prompt: '' } : shot) };
const config = { provider: 'relay', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-secret' };
const source = { kind: 'video', duration: 3, hasAudio: false };
const prepare = async () => ({ frames: [{ time: 0, url: 'data:image/jpeg;base64,YQ==' }], cuts: [1, 2] });
const completion = text => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
async function directory(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'prompt-partial-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('the reported missing second shot retains the full prompt and both completed shots', () => {
  const output = recoverReverseVideoOutput(JSON.stringify(bad), 3);
  assert.equal(output.full, good.full);
  assert.match(output.shots, /第1镜已有结果/);
  assert.match(output.shots, /第3镜已有结果/);
  assert.equal(output.quality.status, 'partial');
  assert.deepEqual(output.quality.issues.filter(issue => issue.part === 'shot').map(issue => issue.index), [1]);
  const fixed = mergeRepairedReverse(output, { full: '不应替换整片', shots: [{ index: 0, start: 0, end: 1, prompt: six('不应改写') }, { index: 1, start: 1, end: 2, prompt: six('第2镜补生成') }] }, 3);
  assert.equal(fixed.full, good.full);
  assert.equal(fixed.shotData[0].prompt, good.shots[0].prompt);
  assert.equal(fixed.shotData[2].prompt, good.shots[2].prompt);
  assert.equal(fixed.quality.status, 'complete');
});

test('repair uses frames around the problem shot and checkpoints a malformed paid repair response', async () => {
  const resume = recoverReverseVideoOutput(JSON.stringify(bad), 3);
  const checkpoints = [], messages = [];
  const output = await reverseMedia({ file: 'fixture.mp4', source, config, resume,
    prepare: async () => ({ frames: Array.from({ length: 31 }, (_, index) => ({ time: index / 10, url: 'data:image/jpeg;base64,YQ==' })), cuts: [1, 2] }),
    onCheckpoint: async value => checkpoints.push(value),
    requestModel: async value => { messages.push(value); return completion('补生成已返回但 JSON 被截断'); } });
  const frameLabels = messages[0][1].content.filter(part => part.type === 'text' && part.text.startsWith('原视频时间')).map(part => part.text);
  assert.ok(frameLabels.includes('原视频时间：2.5 秒'));
  assert.equal(frameLabels.length, 12);
  assert.ok(checkpoints.some(value => value.rawRepairOutput === '补生成已返回但 JSON 被截断'));
  assert.equal(output.full, resume.full);
  assert.equal(output.quality.status, 'partial');
});

test('reverseMedia returns partial quality, then repairs only the problem in one explicit request', async () => {
  let calls = 0;
  const checkpoints = [];
  const output = await reverseMedia({ file: 'fixture.mp4', source, config, prepare, onCheckpoint: async value => checkpoints.push(structuredClone(value)),
    requestModel: async () => completion(++calls === 1 ? '已完成的画面分析' : JSON.stringify(bad)) });
  assert.equal(calls, 2);
  assert.equal(output.quality.status, 'partial');
  assert.equal(output.evidence.audioStatus, 'no-audio');
  assert.ok(checkpoints.some(value => value.full.includes('画面分析')));
  assert.ok(checkpoints.some(value => value.rawOutput?.includes('整片已有结果')));
  const repairCalls = [];
  const fixed = await reverseMedia({ file: 'fixture.mp4', source, config, prepare, resume: output, requestModel: async messages => {
    repairCalls.push(messages);
    return completion(JSON.stringify({ shots: [{ index: 1, start: 1, end: 2, prompt: six('第2镜已修复') }] }));
  } });
  assert.equal(repairCalls.length, 1);
  assert.equal(fixed.quality.status, 'complete');
  assert.equal(fixed.shotData[0].prompt, good.shots[0].prompt);
  assert.match(repairCalls[0][0].content, /不能修改其他部分/);
});

test('a later failed analysis retains completed evidence and explicit resume skips its paid request', async () => {
  const manyFrames = async () => ({ frames: Array.from({ length: 25 }, (_, index) => ({ time: index / 10, url: 'data:image/jpeg;base64,YQ==' })), cuts: [] });
  let firstCalls = 0;
  const partial = await reverseMedia({ file: 'fixture.mp4', source, config, prepare: manyFrames,
    requestModel: async () => { if (++firstCalls === 2) throw new Error('synthetic later failure'); return completion('已完成批次1'); } });
  assert.equal(partial.quality.status, 'partial');
  assert.match(partial.full, /已完成批次1/);
  assert.equal(partial.resume.analyses.length, 1);
  let resumedCalls = 0;
  const result = await reverseMedia({ file: 'fixture.mp4', source, config, prepare: manyFrames, resume: partial,
    requestModel: async () => completion(++resumedCalls < 3 ? `剩余画面分析${resumedCalls}` : JSON.stringify(good)) });
  assert.equal(resumedCalls, 3);
  assert.equal(result.quality.status, 'complete');
});

test('partial reversal and generated drafts survive service recreation without overwriting the original', async t => {
  const root = await directory(t), file = path.join(root, 'sample.mp4'); await writeFile(file, 'synthetic');
  let calls = 0;
  const options = { userDataPath: root, getProfiles: async () => ({ provider: 'relay', relay: { ...config, textModel: 'fixture', visionModel: 'fixture' } }),
    reverseMedia: payload => reverseMedia({ ...payload, prepare, requestModel: async () => completion(++calls === 1 ? '画面证据' : JSON.stringify(bad)) }),
    fetchImpl: async () => Response.json(completion(six('缺光影的草稿', 3).replace(/【光影】[^\n]+\n/, ''))) };
  const service = createPromptLibraryService(options);
  let record = await service.importText('待反推', '用户原稿');
  record = await service.setSource(record.id, record.revision, file, source);
  record = await service.reverse(record.id, record.revision);
  assert.equal(record.reverse.quality.status, 'partial');
  const restored = (await createPromptLibraryService(options).list())[0];
  assert.equal(restored.reverse.quality.status, 'partial');
  assert.equal(restored.variants.restore.full, good.full);
  record = await service.migrate(restored.id, restored.revision);
  const draft = await service.generate({ id: record.id, source: record.variants.template.full, mode: 'template', view: 'full', action: 'refine' });
  assert.equal(draft.quality.status, 'partial');
  const reloaded = (await createPromptLibraryService(options).list())[0];
  assert.equal(reloaded.generatedDraft.text, draft.text);
  assert.equal(reloaded.variants.restore.full, good.full);
});

test('all paid text outputs remain independently recoverable with exact receipts and no duplicate quote entries', async t => {
  const root = await directory(t), store = createGeneratedResults(root);
  const input = { id: 'a'.repeat(40), feature: 'schemes', text: '付费步骤已返回的部分结果', billing: { pointsUsed: '0.125001', billingPending: false } };
  await store.save(input); await store.save(input);
  assert.equal((await createGeneratedResults(root).list()).length, 1);
  assert.equal((await createGeneratedResults(root).read(input.id)).text, input.text);
  assert.equal((await store.read(input.id)).billing.pointsUsed, '0.125001');
  await store.save({ ...input, id: 'b'.repeat(40), billing: { pointsUsed: null, billingPending: true } });
  assert.equal((await store.read('b'.repeat(40))).billing.pointsUsed, null);
  await assert.rejects(store.read('../outside'));
});

test('truncated or interrupted classifier output is checkpointed without automatic extra generation', async () => {
  for (const interrupted of [false, true]) {
    const outputs = []; let calls = 0;
    await assert.rejects(requestClassifierText({ ...config, messages: [{ role: 'user', content: 'facts' }], onCheckpoint: async output => outputs.push(output.text), fetchImpl: async () => {
      calls++;
      return interrupted ? new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"name":"已有草稿"}' } }] }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
        : Response.json({ ...completion('{"name":"已有草稿"}'), choices: [{ message: { content: '{"name":"已有草稿"}' }, finish_reason: 'length' }] });
    } }), error => { assert.match(error.partialContent, /已有草稿/); return true; });
    assert.equal(calls, 1);
    assert.ok(outputs.every(text => text.includes('已有草稿')));
    const recovered = recoverClassifierDraft(outputs[0]);
    assert.equal(recovered.name, '已有草稿'); assert.equal(recovered.quality.passed, false);
    assert.equal(recovered.rawDraftText, outputs[0]);
  }
});

test('replacement reviewer failure retains the candidate without another generation', async () => {
  const plan = { references: [{ materialId: 'product', role: 'product', description: '蓝色杯子', anchors: ['蓝色杯子'] }], forbiddenTerms: [], adaptations: ['适配动作'] };
  let count = 0;
  const result = await generateReplacement({ context: { sourceKind: 'text', replacementMaterials: [{ id: 'product', role: 'product' }], source: '旧稿', originalReverse: '旧稿' }, content: [{ type: 'text', text: 'context' }], request: async () => {
    if (++count === 3) throw new Error('review unavailable');
    return completion(count === 1 ? JSON.stringify(plan) : '蓝色杯子已生成的替换稿');
  } });
  assert.equal(result.choices[0].message.content, '蓝色杯子已生成的替换稿');
  assert.equal(result.quality.status, 'partial'); assert.equal(count, 3);
});
