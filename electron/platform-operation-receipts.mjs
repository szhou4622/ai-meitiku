import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pointUnits, formatPoints } from './platform-operation.mjs';

// Aggregates only locally authorised operation members. Supplier details and
// credentials never enter this file or the renderer notification.
export class PlatformOperationReceipts {
  constructor({ file, onNotice = () => {} }) {
    Object.assign(this, { file, onNotice });
    this.groups = new Map(); this.serial = Promise.resolve(); this.ready = this.load();
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      for (const group of data.groups || []) {
        // An interrupted process has no further live generation steps. Keep
        // its already-authorised tasks together while their receipts recover.
        this.groups.set(group.id, { ...group, finished: true });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  change(work) {
    const next = this.serial.then(async () => {
      await this.ready; work();
      const notices = [];
      for (const group of this.groups.values()) {
        if (!group.finished || group.notified || !group.tasks.length || group.tasks.some(task => task.pointsUsed == null)) continue;
        const total = group.tasks.reduce((sum, task) => sum + pointUnits(task.pointsUsed), 0n);
        group.notified = true;
        notices.push({ id: group.id, pointsUsed: formatPoints(total) });
      }
      const groups = [...this.groups.values()];
      // Retain all unresolved operations and only the latest resolved notices.
      this.groups = new Map(groups.filter(group => !group.notified).concat(groups.filter(group => group.notified).slice(-500)).map(group => [group.id, group]));
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', JSON.stringify({ version: 1, groups: [...this.groups.values()] }), { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
      for (const notice of notices) {
        try { this.onNotice(notice); } catch { /* A closed renderer must not change a settled task's result. */ }
      }
    });
    this.serial = next.catch(() => {});
    return next;
  }
  update(value) {
    return this.change(() => {
      const old = this.groups.get(value.id);
      if (old?.notified) return;
      if (value.finished && !value.tasks.length) { this.groups.delete(value.id); return; }
      const tasks = value.tasks.map(task => {
        const previous = old?.tasks.find(item => item.quoteId === task.quoteId);
        return previous?.pointsUsed != null ? { ...task, pointsUsed: previous.pointsUsed, billingPending: false } : { ...task };
      });
      this.groups.set(value.id, { ...value, tasks });
    });
  }
  settle(value) {
    pointUnits(value.pointsUsed);
    return this.change(() => {
      for (const group of this.groups.values()) {
        const task = group.tasks.find(item => item.quoteId === value.quoteId);
        if (task) Object.assign(task, { pointsUsed: value.pointsUsed, billingPending: false });
      }
    });
  }
}
