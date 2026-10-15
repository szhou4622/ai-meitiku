import { randomUUID } from 'node:crypto';

export function pointUnits(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value))
    throw new Error('积分金额无法确认');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
}
export const formatPoints = units => `${units / 1000000n}.${String(units % 1000000n).padStart(6, '0')}`.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

// Main-process capability only. A server quote still precedes every paid call;
// the sum of settled costs and outstanding quote ceilings cannot exceed consent.
// The server independently puts any receipt above its own quote into review.
export function createPlatformOperation({ maxSteps = 1, onUpdate = async () => {}, id = randomUUID() } = {}) {
  let steps, limit, confirmed = false, cancelled = false, finished = false, identity;
  const tasks = new Map();
  let serial = Promise.resolve();
  const snapshot = () => ({ id, finished, limit: limit == null ? null : formatPoints(limit), tasks: [...tasks.values()].map(task => ({ ...task })) });
  const persist = () => onUpdate(snapshot());
  const configure = count => {
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000 || confirmed) throw new Error('积分操作步骤无法确认');
    steps = count;
  };
  configure(maxSteps);
  return {
    configure,
    snapshot,
    authorize(quote, confirm, { renewed = false } = {}) {
      const next = serial.then(async () => {
        if (finished) throw new Error('积分操作已结束');
        if (cancelled) return false;
        if (tasks.has(quote.quoteId)) return true;
        const price = pointUnits(quote.points);
        const currentIdentity = JSON.stringify([quote.feature, quote.provider, quote.priceVersion, quote.billingBasis]);
        const committed = [...tasks.values()].reduce((sum, task) => sum + pointUnits(task.pointsUsed ?? task.ceiling), 0n);
        if (confirmed && identity !== currentIdentity && !renewed)
          throw Object.assign(new Error('积分报价已更新，已停止后续生成，请重新确认整次操作。'), { code: 'PLATFORM_OPERATION_PRICE_CHANGED' });
        if (confirmed && renewed && (identity !== currentIdentity || committed + price > limit)) {
          const remaining = Math.max(1, steps - [...tasks.values()].filter(task => !task.notSubmitted).length);
          const estimate = committed + price * BigInt(remaining);
          const nextLimit = estimate > limit ? estimate : limit;
          const accepted = await confirm({ title: '积分报价已更新', message: `本次最多扣除 ${formatPoints(nextLimit)} 积分`,
            detail: '此总额包含已完成步骤。已完成内容和积分记录保留，确认后仅继续未完成步骤。',
            buttons: ['确认新报价并继续', '暂不执行'], defaultId: 1, cancelId: 1, noLink: true });
          if (accepted !== true || finished) { cancelled = true; return false; }
          limit = nextLimit; identity = currentIdentity;
        }
        if (!confirmed) {
          // Estimate the operation ceiling from the first server quote and the
          // maximum planned calls (including the existing repair allowance).
          // Later calls must fit this ceiling even if their individual prices grow.
          limit = price * BigInt(steps);
          const accepted = await confirm({ title: '确认使用积分', message: `本次最多扣除 ${formatPoints(limit)} 积分`,
            detail: '本次操作的所有步骤共用此上限，完成后按实际使用积分合计结算。',
            buttons: ['运行', '取消'], defaultId: 1, cancelId: 1, noLink: true });
          if (accepted !== true || finished) { cancelled = true; return false; }
          confirmed = true; identity = currentIdentity;
        }
        if (committed + price > limit)
          throw Object.assign(new Error('本次已达到确认的积分上限，已停止后续生成；已完成部分请查看结果和积分账单。'), { code: 'PLATFORM_OPERATION_LIMIT' });
        tasks.set(quote.quoteId, { quoteId: quote.quoteId, ceiling: quote.points, pointsUsed: null, billingPending: true });
        // Save the authorised membership before the supplier call. A later
        // settlement can then finish the same aggregate notice after restart.
        await persist();
        return true;
      });
      serial = next.catch(() => {});
      return next;
    },
    async record(value) {
      await serial;
      const task = tasks.get(value.quoteId);
      if (!task) return; // Cached, previously paid results are not a new charge.
      if (value.pointsUsed != null) pointUnits(value.pointsUsed);
      tasks.set(value.quoteId, { ...task, pointsUsed: value.pointsUsed ?? null, billingPending: value.pointsUsed == null,
        ...(value.notSubmitted === true ? { notSubmitted: true } : {}) });
      await persist();
    },
    async finish() { finished = true; await serial; await persist(); },
  };
}
