import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createGeneratedResults(userDataPath) {
  const root = path.join(userDataPath, 'generated-results');
  const file = id => {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id || '')) throw new Error('请选择已保存的生成结果');
    return path.join(root, id + '.json');
  };
  return {
    async save({ id = randomUUID(), feature, stage = '', text, billing = null }) {
      if (typeof text !== 'string' || !text.trim()) return null;
      await mkdir(root, { recursive: true, mode: 0o700 });
      const target = file(id), temp = target + '.' + randomUUID() + '.tmp';
      const record = { id, feature, stage, text, billing, savedAt: new Date().toISOString() };
      await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await rename(temp, target);
      return record;
    },
    async read(id) { return JSON.parse(await readFile(file(id), 'utf8')); },
    async list() {
      let names;
      try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const records = [];
      for (const name of names.filter(value => /^[a-zA-Z0-9-]+\.json$/.test(value))) {
        const record = JSON.parse(await readFile(path.join(root, name), 'utf8'));
        const { text, ...summary } = record;
        records.push({ ...summary, characters: text.length });
      }
      return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
  };
}
