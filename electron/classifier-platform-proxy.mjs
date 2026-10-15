import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

// The bundled classifier understands OpenAI-compatible HTTP. This local
// capability carries no supplier credential and cannot choose a provider URL.
export async function createClassifierPlatformProxy(execute) {
  const token = randomBytes(32).toString('hex');
  let taskId = '', operation; const results = new Map();
  const server = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${token}` || !taskId)
      return reply(403, { error: { code: 'LOCAL_CAPABILITY_REQUIRED', message: '本地积分任务授权无效' } });
    const currentTaskId = taskId, currentOperation = operation;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 48 * 1024 * 1024) throw new Error('素材请求过大'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks));
      const payload = { messages: input.messages, max_tokens: input.max_tokens || 4096, temperature: input.temperature ?? 0.2,
        ...(input.response_format ? { response_format: input.response_format } : {}) };
      const requestId = 'classifier:' + createHash('sha256').update(currentTaskId + JSON.stringify(payload)).digest('hex');
      if (!results.has(requestId)) results.set(requestId, execute({ feature: 'classifier', provider: 'volcengine', payload, requestId, operation: currentOperation }));
      const completed = await results.get(requestId);
      const result = { ...completed.result, object: 'chat.completion', created: Math.floor(Date.now() / 1000) };
      if (!input.stream) return reply(200, result);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ ...result, object: 'chat.completion.chunk', choices: result.choices.map((c, index) => ({ index, delta: c.message, finish_reason: c.finish_reason })) })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { reply(409, { error: { code: error.code || 'PLATFORM_TASK_FAILED', message: '积分分类任务未完成，请查看原任务状态；不会切换个人 API。' } }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token,
    selectTask(id, budget) { if (typeof id !== 'string' || !id) throw new Error('missing logical classifier task'); if (taskId !== id) results.clear(); taskId = id; operation = budget; },
    close: () => new Promise(resolve => server.close(resolve)) };
}
