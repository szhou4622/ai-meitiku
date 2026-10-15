import { createHash } from 'node:crypto';
import { summarizePromptBilling } from './prompt-billing.mjs';

// Only messages and generation options cross the platform boundary. No
// personal provider settings or provider credentials are passed here.
export function createPromptPlatformRequests({ operation, config, platformExecute,
  budget, assertAccess = () => {}, progress = () => {}, journal = async () => {}, readJournal = async () => ({ tasks: [] }) }) {
  const tasks = new Map();
  let history;
  const summary = () => summarizePromptBilling([...tasks.values()]);
  const request = async (messages, options = {}) => {
    assertAccess();
    if (typeof platformExecute !== 'function') throw Object.assign(new Error('提示词积分接口未接通'), { code: 'PLATFORM_API_UNAVAILABLE' });
    const input = { messages, temperature: options.temperature ?? 0.3, max_tokens: options.max_tokens ?? 16000 };
    if (Buffer.byteLength(JSON.stringify(input)) > 60 * 1024 ** 2)
      throw Object.assign(new Error('本次参考画面总大小过大，请减少参考图或缩小图片后重试；本次未提交生成'), { code: 'PROMPT_INPUT_TOO_LARGE' });
    const baseRequestId = 'prompt:' + createHash('sha256').update(JSON.stringify({ ...operation, input })).digest('hex');
    history ??= await readJournal();
    const previous = history.tasks?.findLast(task => (task.baseRequestId || task.requestId) === baseRequestId);
    // Only a later explicit operation after a confirmed cancellation may use
    // another quote. Completed or uncertain paid tasks retain their identity.
    const requestId = previous?.cancelled ? `${baseRequestId}:retry:${previous.quoteId}` : previous?.requestId || baseRequestId;
    progress('正在获取积分报价');
    let completed, activeQuoteId, activeRequestId = requestId;
    try {
      completed = await platformExecute({ feature: 'prompt-library', provider: 'volcengine', payload: input, requestId, operation: budget,
        onQuoted: async (quoteId, metadata) => {
          activeRequestId = metadata?.requestId || requestId;
          activeQuoteId = quoteId;
          tasks.set(quoteId, { quoteId, requestId: activeRequestId, baseRequestId, pointsUsed: null, billingPending: true });
          await journal(summary());
          progress('正在生成');
        },
        onNotSubmitted: async quoteId => {
          const task = tasks.get(quoteId);
          if (task) tasks.set(quoteId, { ...task, pointsUsed: '0', billingPending: false, cancelled: true });
          await journal(summary());
        } });
    } catch (error) {
      if (['PLATFORM_TASK_CANCELLED', 'PLATFORM_OPERATION_LIMIT', 'PLATFORM_OPERATION_PRICE_CHANGED', 'QUOTE_EXPIRED'].includes(error?.code) && activeQuoteId) {
        tasks.set(activeQuoteId, { quoteId: activeQuoteId, requestId: activeRequestId, baseRequestId, pointsUsed: '0.000000', billingPending: false, cancelled: true });
        await journal(summary());
        if (error.code === 'PLATFORM_TASK_CANCELLED' && [...tasks.values()].some(task => !task.cancelled))
          error.message = `已取消后续生成，已完成部分${summary().pointsUsed == null ? '的积分待核对' : `使用 ${summary().pointsUsed} 积分`}，原稿保留。`;
      }
      if (error?.terminalFailure && activeQuoteId) {
        tasks.set(activeQuoteId, { quoteId: activeQuoteId, requestId: activeRequestId, baseRequestId,
          pointsUsed: error.pointsUsed ?? null, billingPending: error.pointsUsed == null });
        await journal(summary());
      }
      throw error;
    }
    tasks.set(completed.quoteId, { quoteId: completed.quoteId, requestId: activeRequestId, baseRequestId, pointsUsed: completed.pointsUsed,
      billingPending: completed.billingPending === true });
    await journal(summary());
    if (completed.result?.model) config.model = String(completed.result.model);
    // Keep paid output even when truncated; the feature displays it as a partial draft.
    return completed.result;
  };
  return { request, summary, prepare: count => budget?.configure(count), finish: async () => budget?.finish() };
}
