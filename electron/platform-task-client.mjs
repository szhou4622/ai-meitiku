import { createHash, randomUUID } from "node:crypto";

export const PLATFORM_APP_NAME = "ai-media-library";
const pairs = { schemes: "volcengine", classifier: "volcengine", "prompt-library": "volcengine", voice: "minimax", "subtitle-removal": "aliyun" };
const failure = (code, message) => Object.assign(new Error(message), { code });
const points = value => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value))
    throw failure("INVALID_PLATFORM_QUOTE", "服务器返回的积分报价无法确认，本次未提交任务。");
  return value.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
};

export function decodePlatformQuote(body, { feature, provider } = {}) {
  if (body?.ok !== true || body.app_name !== PLATFORM_APP_NAME || !/^[a-f0-9]{40}$/.test(body.quote_id || "")
      || body.feature !== feature || body.provider !== provider
      || (body.billing_basis !== "supplier_debit_with_zero_fallback" && !(pairs[feature] === provider && body.billing_basis === "supplier_usage_tariff"))
      || !["fixed", "estimate"].includes(body.pricing_kind) || !Number.isFinite(body.expires_at))
    throw failure("INVALID_PLATFORM_QUOTE", "服务器返回的积分报价无法确认，本次未提交任务。");
  return Object.freeze({ quoteId: body.quote_id, feature, provider, points: points(body.points),
    estimated: body.pricing_kind === "estimate", expiresAt: body.expires_at,
    priceVersion: String(body.price_version || ""), billingBasis: body.billing_basis });
}

export function platformConfirmation(quote) {
  return {
    title: "确认使用积分",
    message: `本次${quote.estimated ? "预计需要" : "需要"} ${quote.points} 积分`,
    detail: "点击运行开始生成，完成后显示最终扣除积分。",
    buttons: ["运行", "取消"], defaultId: 1, cancelId: 1, noLink: true,
  };
}

export function expiredQuoteConfirmation() {
  return {
    title: "积分报价已过期",
    message: "重新报价并继续执行？",
    detail: "当前步骤尚未执行。已完成的内容和积分记录会保留，仅继续未完成步骤；最新报价变化时会重新确认。",
    buttons: ["重新报价并继续", "暂不执行"], defaultId: 1, cancelId: 1, noLink: true,
  };
}

export class PlatformTaskClient {
  constructor({ request, confirm, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 1500, timeoutMs = 15 * 60 * 1000, subtitleTimeoutMs = 45 * 60 * 1000 }) {
    Object.assign(this, { request, confirm, now, wait, pollMs, timeoutMs, subtitleTimeoutMs });
    this.pending = new Map();
  }
  // The caller supplies its durable logical task ID. Retries use the same quote;
  // payment mode is selected by the feature before it enters this client.
  execute({ feature, provider, payload, requestId = randomUUID(), onQuoted = async () => {}, onNotSubmitted = async () => {}, onProgress = async () => {}, operation }) {
    if (pairs[feature] !== provider) return Promise.reject(failure("FEATURE_PROVIDER_MISMATCH", "此功能的积分服务商无效"));
    const identity = JSON.stringify({ feature, provider, payload });
    const old = this.pending.get(requestId);
    if (old) {
      if (old.identity !== identity) return Promise.reject(failure("IDEMPOTENCY_CONFLICT", "任务编号已经用于其他内容"));
      return old.promise;
    }
    const promise = this.perform({ feature, provider, payload, requestId, onQuoted, onNotSubmitted, onProgress, operation });
    this.pending.set(requestId, { identity, promise });
    promise.finally(() => { if (this.pending.get(requestId)?.promise === promise) this.pending.delete(requestId); }).catch(() => {});
    return promise;
  }
  async perform({ feature, provider, payload, requestId, onQuoted, onNotSubmitted, onProgress, operation }) {
    let currentRequestId = requestId, renewed = false;
    let body = await this.request("quote", { request_id: currentRequestId, feature, provider, api_source: "platform_api", payload });
    for (;;) {
      const quote = decodePlatformQuote(body, { feature, provider });
      await onQuoted(quote.quoteId, { requestId: currentRequestId });
      try {
        const completed = await this.performQuoted(body, quote, operation, renewed, onProgress);
        await operation?.record(completed);
        return completed;
      } catch (error) {
        if (error?.code === 'QUOTE_EXPIRED' && !error.terminalFailure) {
          let notSubmitted = false;
          try {
          // The same task may have been accepted by another process. Only a
          // trusted unsubmitted status permits a new quote identity.
          const state = await this.request('status', { quote_id: quote.quoteId });
          const checked = decodePlatformQuote(state, { feature, provider });
          if (checked.quoteId !== quote.quoteId) throw failure('INVALID_PLATFORM_RESULT', '原任务状态无法确认，请稍后查看原任务。');
          if (state.status !== 'quoted') {
            body = state;
            continue;
          }
          notSubmitted = true;
          await operation?.record({ quoteId: quote.quoteId, pointsUsed: '0', notSubmitted: true });
          await onNotSubmitted(quote.quoteId, { requestId: currentRequestId });
          if (await this.confirm(expiredQuoteConfirmation(), quote) !== true) {
            throw Object.assign(failure('PLATFORM_TASK_CANCELLED', '已取消后续执行，已完成内容和积分记录已保留。'),
              { quoteId: quote.quoteId, pointsUsed: '0', billingPending: false, notSubmitted: true });
          }
          // Deterministic across retries/restarts and within the server's
          // 128-character limit, even for a maximum-length original ID.
          currentRequestId = 'renew:' + createHash('sha256').update(currentRequestId + ':' + quote.quoteId).digest('hex');
          body = await this.request('quote', { request_id: currentRequestId, feature, provider, api_source: 'platform_api', payload });
          renewed = true;
          continue;
          } catch (recoveryError) {
            recoveryError.quoteId = quote.quoteId;
            recoveryError.billingPending = !notSubmitted;
            if (notSubmitted) { recoveryError.pointsUsed = '0'; recoveryError.notSubmitted = true; }
            throw recoveryError;
          }
        }
        if (operation?.snapshot().tasks.some(task => task.quoteId === quote.quoteId)) {
          await operation.record({ quoteId: quote.quoteId, pointsUsed: error.pointsUsed ?? null });
          error.quoteId = quote.quoteId;
          error.billingPending = error.pointsUsed == null;
        }
        throw error;
      }
    }
  }
  async performQuoted(body, quote, operation, renewed = false, onProgress = async () => {}) {
    const { feature } = quote;
    if (body.status === "succeeded") return this.completed(body);
    if (["quoted", "reserve-failed"].includes(body.status)) {
      if (body.status === 'quoted' && this.now() >= quote.expiresAt * 1000) throw failure("QUOTE_EXPIRED", "积分报价已过期，请重新发起任务。");
      const accepted = operation
        ? await operation.authorize(quote, options => this.confirm(options, quote), { renewed })
        : await this.confirm(platformConfirmation(quote), quote);
      if (accepted !== true)
        throw failure("PLATFORM_TASK_CANCELLED", "已取消，本次未提交任务，也未扣积分。");
      if (body.status === 'quoted' && this.now() >= quote.expiresAt * 1000) throw failure("QUOTE_EXPIRED", "积分报价已过期，请重新发起任务。");
    } else if (!['reserving', 'executing', 'settling', 'settlement-running'].includes(body.status)) {
      return this.completed(body);
    }
    // No user budget, ceiling or caller-provided cost is sent to the server.
    let result;
    try { result = await this.request("run", { quote_id: quote.quoteId, confirm_run: true }); }
    catch (error) {
      // A transport timeout may happen after acceptance. Query the original
      // quote; never obtain a fresh quote and repeat the paid supplier call.
      if (!['network', 'TimeoutError'].includes(error?.kind || error?.name)) throw error;
      result = await this.request("status", { quote_id: quote.quoteId });
    }
    // Large videos may still be accepted/processing after the text-task wait
    // limit. Poll the original quote; never create another supplier operation.
    const until = this.now() + (feature === 'subtitle-removal' ? this.subtitleTimeoutMs : this.timeoutMs);
    const pendingResult = () => ['reserving', 'executing', 'settling', 'settlement-running'].includes(result?.status)
      || feature === 'subtitle-removal' && result?.status === 'unknown' && result.transfer?.phase
        && !['source-expired', 'abandoned'].includes(result.transfer.phase);
    await onProgress(result);
    while (pendingResult()) {
      if (this.now() >= until) throw failure("PLATFORM_TASK_PENDING", "任务仍在处理，请稍后查看原任务；不会重复提交。");
      await this.wait(this.pollMs);
      result = await this.request(result.status === 'settling' ? "run" : "status", {
        quote_id: quote.quoteId, ...(result.status === 'settling' ? { confirm_run: true } : {}),
      });
      await onProgress(result);
    }
    return this.completed(result);
  }
  completed(body) {
    if (body?.app_name !== PLATFORM_APP_NAME || body.ok !== true)
      throw failure("INVALID_PLATFORM_RESULT", "平台任务返回无法确认，请查看原任务状态。");
    if (body.status === "succeeded") return { result: body.result, pointsUsed: points(body.points_used), quoteId: body.quote_id };
    if (["awaiting-bill", "bill-review"].includes(body.status) && body.billing_pending === true && body.result != null)
      return { result: body.result, pointsUsed: null, billingPending: true, quoteId: body.quote_id };
    if (body.status === "unknown") throw failure("SUPPLIER_OUTCOME_UNKNOWN", "任务结果尚未确认，已保留原任务等待核对；不会自动重复生成或重复扣分。");
    if (body.status === "failed") {
      const charged = body.points_used != null ? points(body.points_used) : null;
      throw Object.assign(failure(body.error_code || "PLATFORM_TASK_FAILED", charged != null
        ? `任务处理失败，本次扣除 ${charged} 积分。请保留原任务。`
        : body.billing_pending ? "任务处理失败，积分结算待核对；请保留原任务。" : "任务处理失败，请查看原任务的积分结算记录。"),
        { terminalFailure: true, billingPending: body.billing_pending === true, pointsUsed: charged, quoteId: body.quote_id });
    }
    throw failure(body.error_code || "PLATFORM_TASK_PENDING", "任务状态需要确认，请查看原任务，不要重复提交。");
  }
}
