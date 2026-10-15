export function modelContentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.text || '').join('') : '';
}
function failure(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
function jsonObject(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) throw failure('invalid_json', '文本模型返回的内容不是完整 JSON');
  try { const value = JSON.parse(raw.slice(first, last + 1)); if (!value || Array.isArray(value)) throw new Error(); return value; }
  catch { throw failure('invalid_json', '文本模型返回的 JSON 格式错误或不完整'); }
}
export function splitClassifierBrief(brief, size = 12000) {
  const result = [];
  const text = String(brief || '');
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    result.push(text.slice(offset, end)); offset = end;
  }
  return result;
}
export async function prepareClassifierBrief(brief, summarize, progress = () => {}) {
  let prepared = String(brief || '').trim();
  for (let round = 0; prepared.length > 12000 && round < 6; round++) {
    const chunks = splitClassifierBrief(prepared);
    const summaries = [];
    for (let index = 0; index < chunks.length; index++) {
      progress({ round: round + 1, current: index + 1, total: chunks.length });
      const summary = jsonObject(await summarize(chunks[index], index, chunks.length)).summary;
      if (typeof summary !== 'string' || !summary.trim()) throw failure('empty_summary', `第 ${index + 1} 段资料未得到有效摘要，原始资料仍保留在文本框中`);
      summaries.push(summary.trim());
    }
    const next = summaries.join('\n\n');
    if (next.length >= prepared.length) throw failure('summary_not_reduced', '资料整理未能缩短长文本，请分批整理；原始资料没有被截断');
    prepared = next;
  }
  if (prepared.length > 12000) throw failure('brief_too_large', '产品资料仍过长，请分批整理；原始资料没有被截断');
  return prepared;
}

export async function requestClassifierText({ baseUrl, apiKey, model, messages, maxTokens = 4096,
  requireJson = true, validateContent = null, fetchImpl = fetch, onProgress = () => {}, diagnostic = () => {}, onCheckpoint = async () => {}, allowOutputRetry = false, idleMs = 90000, timeoutMs = 300000 }) {
  let budget = maxTokens, retriedOutput = false, jsonMode = requireJson, streaming = true;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const started = Date.now(), controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(failure('total_timeout', '文本模型处理超过最长等待时间，请稍后重试')), timeoutMs);
    let reader;
    const timed = async operation => {
      let timer, abort;
      const stop = new Promise((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
        timer = setTimeout(() => { controller.abort(failure('idle_timeout', '文本模型长时间没有返回新内容，请检查模型服务或稍后重试')); }, idleMs);
      });
      try { return await Promise.race([operation(), stop]); }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
    };
    let content = '', finishReason = '', reasoningChars = 0, usage = null;
    try {
      const body = { model, messages, temperature: 0.2, max_tokens: budget, stream: streaming, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) };
      diagnostic('start', { model, attempt, maxTokens: budget, inputChars: messages.reduce((n, m) => n + modelContentText(m.content).length, 0), streaming });
      const response = await timed(() => fetchImpl(`${baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', accept: 'text/event-stream, application/json' }, body: JSON.stringify(body), signal: controller.signal }));
      if (!response.ok) {
        const payload = await timed(() => response.json()).catch(error => { if (controller.signal.aborted) throw error; return {}; });
        const message = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
        if (response.status === 400 && jsonMode && /response_format|json_object|json.?mode/i.test(message)) { jsonMode = false; continue; }
        if (response.status === 400 && streaming && /stream/i.test(message)) { streaming = false; continue; }
        throw failure('provider_error', `文本模型请求失败：${message}`, { httpStatus: response.status, providerCode: payload?.error?.code || payload?.code });
      }
      const consume = payload => {
        if (payload.error) throw failure('provider_error', `文本模型流式响应失败：${payload.error.message || '模型服务错误'}`);
        const choice = payload.choices?.find(c => c.index === 0) || payload.choices?.[0];
        const message = choice?.delta || choice?.message;
        if (message?.refusal) throw failure('refusal', '文本模型拒绝生成这份草案，请检查产品资料和分类要求');
        content += modelContentText(message?.content);
        reasoningChars += modelContentText(message?.reasoning_content).length;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (payload.usage) usage = payload.usage;
        onProgress({ receivedChars: content.length, thinking: !content.length && reasoningChars > 0 });
      };
      if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
        if (!response.body) throw failure('empty_response', '模型返回了空的流式响应');
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let pending = '', doneMarker = false;
        const event = raw => {
          const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
          if (!data) return;
          if (data === '[DONE]') { doneMarker = true; return; }
          try { consume(JSON.parse(data)); } catch (error) { if (error.code) throw error; throw failure('invalid_stream', '模型流式返回的数据格式错误'); }
        };
        while (!doneMarker) {
          const chunk = await timed(() => reader.read());
          pending += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
          let match;
          while ((match = /\r?\n\r?\n/.exec(pending))) { event(pending.slice(0, match.index)); pending = pending.slice(match.index + match[0].length); if (doneMarker) break; }
          if (pending.length > 2000000 || content.length > 2000000) throw failure('response_too_large', '模型返回的内容过长，请缩小生成范围');
          if (chunk.done) { if (pending.trim()) event(pending); break; }
        }
        if (!doneMarker && !finishReason) throw failure('stream_interrupted', '模型连接在草案返回完成前中断，请重新生成');
      } else consume(await timed(() => response.json()));
      diagnostic('response', { model, attempt, finishReason, receivedChars: content.length, reasoningChars, usage, durationMs: Date.now() - started });
      if (content.trim()) await onCheckpoint({ text: content, finishReason, usage });
      if (finishReason === 'length') throw failure('output_truncated', '草案因模型输出长度限制被截断');
      if (finishReason === 'content_filter') throw failure('content_filter', '模型服务限制了这份资料的输出，请检查产品资料');
      if (!content.trim()) throw failure('empty_response', reasoningChars ? '模型仅返回了思考内容，没有返回草案正文' : '模型返回了空正文');
      if (requireJson) jsonObject(content);
      if (validateContent) {
        try { validateContent(content); }
        catch { throw failure('invalid_schema', '文本模型返回的分类结构不完整，未覆盖所需字段'); }
      }
      return content;
    } catch (error) {
      if (content.trim()) { await onCheckpoint({ text: content, finishReason, usage }); error.partialContent = content; }
      diagnostic('error', { model, attempt, code: error.code || error.name, finishReason, receivedChars: content.length, reasoningChars, durationMs: Date.now() - started });
      if (allowOutputRetry && requireJson && attempt < 4 && !retriedOutput && ['output_truncated', 'invalid_json', 'invalid_schema', 'empty_response'].includes(error.code)) {
        retriedOutput = true; budget = Math.min(16384, Math.max(8192, budget * 2));
        onProgress({ receivedChars: 0, retrying: true }); continue;
      }
      throw error;
    } finally {
      clearTimeout(totalTimer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  throw failure('compatibility_error', '当前模型未能返回兼容的完整草案');
}
