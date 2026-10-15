import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";

const validId = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export class PlatformBillingWatch {
  constructor({ file, request, onSettled = () => {}, intervalMs = 30_000 }) {
    Object.assign(this, { file, request, onSettled, intervalMs });
    this.ids = new Set();
    this.serial = Promise.resolve();
    this.ready = this.load();
  }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (value.version === 1 && Array.isArray(value.quoteIds))
        value.quoteIds.filter(validId).slice(0, 10000).forEach(id => this.ids.add(id));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  persist() {
    const value = JSON.stringify({ version: 1, quoteIds: [...this.ids] });
    const operation = this.serial.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file + ".tmp", value, { mode: 0o600 });
      await rename(this.file + ".tmp", this.file);
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async add(id) {
    if (!validId(id)) throw new Error("Invalid platform billing task");
    await this.ready;
    this.ids.add(id);
    await this.persist();
  }
  async tick() {
    await this.ready;
    if (this.running) return;
    this.running = true;
    try {
      for (const id of [...this.ids]) {
        try {
          // Status may retry a verified settlement, never supplier generation.
          const value = await this.request("status", { quote_id: id });
          if (value?.ok !== true || value.app_name !== "ai-media-library" || value.quote_id !== id) continue;
          if (["succeeded", "failed"].includes(value.status) && value.billing_pending !== true && typeof value.points_used === "string"
              && /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value.points_used)) {
            this.ids.delete(id);
            await this.persist();
            this.onSettled({ quoteId: id, pointsUsed: value.points_used, ...(value.status === 'failed' ? { failed: true } : {}) });
          }
        } catch { /* Keep the durable original ID when offline/auth/billing fails. */ }
      }
    } finally { this.running = false; }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    void this.tick().catch(() => {});
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
