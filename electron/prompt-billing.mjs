export function summarizePromptBilling(tasks) {
  const pending = tasks.some(task => task.billingPending || task.pointsUsed == null);
  const units = pending ? null : tasks.reduce((sum, task) => {
    if (!/^\d+(?:\.\d{1,6})?$/.test(String(task.pointsUsed))) throw new Error('积分回执金额无法确认');
    const [whole, fraction = ''] = String(task.pointsUsed).split('.');
    return sum + BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  }, 0n);
  return { apiSource: 'platform_api', quoteId: tasks.at(-1)?.quoteId,
    pointsUsed: units == null ? null : `${units / 1000000n}.${String(units % 1000000n).padStart(6, '0')}`,
    billingPending: pending, tasks: tasks.map(task => ({ ...task })) };
}

export function updatePromptBilling(billing, value) {
  if (!billing) return billing;
  if (!billing.tasks?.length) return billing.quoteId === value.quoteId
    ? { ...billing, billingPending: false, pointsUsed: value.pointsUsed } : billing;
  if (!billing.tasks.some(task => task.quoteId === value.quoteId)) return billing;
  return summarizePromptBilling(billing.tasks.map(task => task.quoteId === value.quoteId
    ? { ...task, pointsUsed: value.pointsUsed, billingPending: false } : task));
}
