import test from 'node:test';
import assert from 'node:assert/strict';
import { apiTaskSelection } from '../electron/api-usage.mjs';
import { randomUUID } from 'node:crypto';
import { requestClassifierText, prepareClassifierBrief, splitClassifierBrief } from '../electron/classifier-text-client.mjs';
const options = { baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-secret', model: 'synthetic', messages: [{ role: 'user', content: 'synthetic product facts' }] };
const valid = '{"taxonomy":{"01产品":["外观"]}}';
const answer = (content = valid, finish = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), { headers: { 'content-type': 'application/json' } });
function sse(payloads, fragmentSize = 7) {
  const bytes = new TextEncoder().encode(payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\r\n\r\n`).join(''));
  let offset = 0;
  return new Response(new ReadableStream({ pull(c) { if (offset >= bytes.length) c.close(); else { c.enqueue(bytes.slice(offset, offset += fragmentSize)); } } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('fragmented UTF-8 SSE emits progressive content and records usage without logging product content or credentials', async () => {
  const progress = [], diagnostics = [];
  const result = await requestClassifierText({ ...options, fetchImpl: async () => sse([
    { choices: [{ index: 0, delta: { reasoning_content: 'private reasoning' } }] },
    { choices: [{ index: 0, delta: { content: valid.slice(0, 13) } }] },
    { choices: [{ index: 0, delta: { content: valid.slice(13) }, finish_reason: 'stop' }] },
    { choices: [], usage: { total_tokens: 30 } }, '[DONE]',
  ], 1), onProgress: p => progress.push(p), diagnostic: (event, p) => diagnostics.push({ event, ...p }) });
  assert.equal(result, valid);
  assert.ok(progress.some(p => p.thinking));
  assert.ok(progress.some(p => p.receivedChars > 0 && p.receivedChars < valid.length));
  assert.equal(diagnostics.at(-1).usage.total_tokens, 30);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private reasoning|synthetic-secret|synthetic product facts/);
});

test('truncated output gets exactly one retry with a larger budget', async () => {
  const budgets = [], progress = [];
  const result = await requestClassifierText({ ...options, allowOutputRetry: true, onProgress: p => progress.push(p), fetchImpl: async (_url, init) => {
    budgets.push(JSON.parse(init.body).max_tokens);
    return budgets.length === 1 ? answer('{"taxonomy":', 'length') : answer();
  } });
  assert.equal(result, valid);
  assert.deepEqual(budgets, [4096, 8192]);
  assert.ok(progress.some(p => p.retrying));
});
for (const [name, response, code] of [
  ['empty body', () => answer(''), 'empty_response'],
  ['invalid JSON', () => answer('{"taxonomy":broken}'), 'invalid_json'],
  ['length limit', () => answer(valid, 'length'), 'output_truncated'],
]) test(`${name} produces a specific bounded error`, async () => {
  let calls = 0;
  await assert.rejects(requestClassifierText({ ...options, fetchImpl: async () => { calls++; return response(); } }), e => e.code === code);
  assert.equal(calls, 1);
});

test('connection check rejects empty choices and reasoning-only content instead of reporting success', async () => {
  for (const payload of [{ choices: [] }, { choices: [{ message: { content: '', reasoning_content: 'thinking' } }] }]) {
    await assert.rejects(requestClassifierText({ ...options, requireJson: false, fetchImpl: async () => new Response(JSON.stringify(payload)) }), e => e.code === 'empty_response');
  }
  assert.equal(await requestClassifierText({ ...options, requireJson: false, fetchImpl: async () => answer('OK') }), 'OK');
});

test('an interrupted stream is not accepted even if its partial JSON happens to parse', async () => {
  await assert.rejects(requestClassifierText({ ...options, fetchImpl: async () => sse([{ choices: [{ delta: { content: valid } }] }]) }), e => e.code === 'stream_interrupted');
});

test('unsupported JSON mode falls back only for the named parameter; unrelated 400 is not replayed', async () => {
  const bodies = [];
  await requestClassifierText({ ...options, fetchImpl: async (_u, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return body.response_format ? new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), { status: 400 }) : answer();
  } });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].response_format, undefined);
  let calls = 0;
  await assert.rejects(requestClassifierText({ ...options, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { message: 'context length exceeded' } }), { status: 400 }); } }), /context length/);
  assert.equal(calls, 1);
});

test('an endpoint rejecting streaming falls back to a validated ordinary JSON response', async () => {
  let calls = 0;
  await requestClassifierText({ ...options, fetchImpl: async (_u, init) => {
    calls++; return JSON.parse(init.body).stream ? new Response(JSON.stringify({ error: { message: 'stream unsupported' } }), { status: 400 }) : answer();
  } });
  assert.equal(calls, 2);
});

test('stalled stream times out distinctly and cancels its reader', async () => {
  let cancelled = false;
  await assert.rejects(requestClassifierText({ ...options, idleMs: 20, timeoutMs: 500, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) }), e => e.code === 'idle_timeout');
  assert.equal(cancelled, true);
});

test('long full-text input is entirely submitted in chunks and recursively reduced without cutting its tail', async () => {
  const brief = '产品事实\n'.repeat(40000) + '最后禁止事项';
  let initialParts = [], rounds = [];
  const prepared = await prepareClassifierBrief(brief, async (chunk, index, total) => {
    if (total === splitClassifierBrief(brief).length) initialParts.push(chunk);
    return JSON.stringify({ summary: '已保留产品事实和禁止事项'.repeat(200) });
  }, p => rounds.push(p.round));
  assert.equal(initialParts.join(''), brief);
  assert.ok(prepared.length <= 12000);
  assert.ok(Math.max(...rounds) > 1);
  assert.equal(splitClassifierBrief('a'.repeat(11999) + '😀结尾').join(''), 'a'.repeat(11999) + '😀结尾');
});

test('empty or non-reducing long-document summaries fail explicitly rather than producing a misleading draft', async () => {
  const brief = '长资料'.repeat(6000);
  await assert.rejects(prepareClassifierBrief(brief, async () => '{"summary":""}'), e => e.code === 'empty_summary');
  await assert.rejects(prepareClassifierBrief(brief, async chunk => JSON.stringify({ summary: chunk })), e => e.code === 'summary_not_reduced');
});

test('ongoing stream data resets idle waiting instead of cutting off an active generation', async () => {
  const fragments = [valid.slice(0, 10), valid.slice(10, 20), valid.slice(20)];
  let index = 0;
  const response = new Response(new ReadableStream({ async pull(controller) {
    await new Promise(resolve => setTimeout(resolve, 12));
    if (index < fragments.length) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: fragments[index++] } }] })}\n\n`));
    else { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
  } }), { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(await requestClassifierText({ ...options, idleMs: 30, timeoutMs: 500, fetchImpl: async () => response }), valid);
});

test('output refusal is distinct and is never automatically replayed', async () => {
  let calls = 0;
  await assert.rejects(requestClassifierText({ ...options, fetchImpl: async () => {
    calls++; return sse([{ choices: [{ delta: { refusal: 'blocked' }, finish_reason: 'content_filter' }] }, '[DONE]']);
  } }), e => e.code === 'refusal');
  assert.equal(calls, 1);
});

test('full draft workflow receives all long-document segments, streams progress, and retains a usable draft if audit fails', async () => {
  const { readFile } = await import('node:fs/promises');
  const { extractClassifierDraft, extractAuditedClassifierDraft, validateClassifierDraftQuality } = await import('../electron/classifier-draft.mjs');
  const source = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function generateClassifierTemplateDraft('), source.indexOf('\nfunction chatMessageText('));
  const submitted = [], progress = [];
  const request = async options => {
    options.onProgress({ receivedChars: 25 });
    if (options.messages[0].content.includes('产品资料整理器')) {
      submitted.push(options.messages[1].content);
      return '{"summary":"产品：测试品；禁止类目：虚构功效"}';
    }
    if (options.messages[0].content.includes('质量审查器')) throw Object.assign(new Error('audit timeout'), { code: 'idle_timeout' });
    return JSON.stringify({ name: '测试方案', product_name: '测试品', taxonomy: { '01外观': ['包装正面', '包装背面'] }, rules: '不得虚构功效', naming_rule: '产品名_二级分类_序号' });
  };
  const generate = new Function('apiTaskSelection', 'randomUUID', 'path', 'classifierRuntimeRoot', 'readJson', 'loadClassificationProfiles', 'classificationApiKeyForProvider', 'classificationProviderFromSettings', 'requestClassifierJson', 'prepareClassifierBrief', 'extractClassifierDraft', 'extractAuditedClassifierDraft', 'validateClassifierDraftQuality', 'applicationLog', `${code}; return generateClassifierTemplateDraft;`)(
    apiTaskSelection, randomUUID, (await import('node:path')).default, async () => '/synthetic', async () => ({ text_model: { model: 'synthetic', base_url: 'https://example.invalid/v1' } }), async () => ({ provider: 'volcengine', volcengine: { useOwnApi: true } }), () => 'synthetic', () => 'synthetic', request, prepareClassifierBrief, extractClassifierDraft, extractAuditedClassifierDraft, validateClassifierDraftQuality, { write() {} });
  const brief = '测试品产品资料'.repeat(10000) + '最后禁止事项';
  const result = await generate(brief, value => progress.push(value));
  assert.ok(submitted.at(-1).includes('最后禁止事项'));
  assert.equal(submitted.length, splitClassifierBrief(brief).length);
  assert.ok(progress.some(value => value.receivedChars === 25));
  assert.equal(result.product_name, '测试品');
  assert.equal(result.quality.passed, false);
  assert.ok(result.quality.issues.some(issue => issue.code === 'audit_unavailable'));
});

test('well-formed JSON with a missing taxonomy gets one schema recovery attempt', async () => {
  const { extractClassifierDraft } = await import('../electron/classifier-draft.mjs');
  let calls = 0;
  const result = await requestClassifierText({ ...options, allowOutputRetry: true, validateContent: extractClassifierDraft, fetchImpl: async () => ++calls === 1 ? answer('{"name":"missing taxonomy"}') : answer() });
  assert.equal(result, valid);
  assert.equal(calls, 2);
});
