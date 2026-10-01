import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectSpreadsheetLinkText,
  importDownloadLinksFromSpreadsheet,
  normalizeImportedDownloadLinks,
} from "../electron/download-link-import.mjs";

test("Excel AST 中的显示文字和超链接目标都可以读取", () => {
  const text = collectSpreadsheetLinkText({
    content: [{ type: "cell", text: "分享地址", children: [{ metadata: { link: "https://xhslink.cn/aBc123" } }] }],
  });
  assert.match(text, /分享地址/);
  assert.match(text, /https:\/\/xhslink\.cn\/aBc123/);
});

test("导入链接会补全协议、去重并限制为 100 条", () => {
  const source = Array.from({ length: 105 }, (_, index) => `v.douyin.com/item-${index}`).join("\n");
  const result = normalizeImportedDownloadLinks(`${source}\nv.douyin.com/item-0`);
  assert.equal(result.foundCount, 105);
  assert.equal(result.importedCount, 100);
  assert.equal(result.truncatedCount, 5);
  assert.equal(result.links[0].url, "https://v.douyin.com/item-0");
});

test("CSV 文件中的抖音和小红书链接可以导入", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-link-import-"));
  const filePath = path.join(directory, "links.csv");
  await writeFile(filePath, "平台,链接\n抖音,https://v.douyin.com/test\n小红书,xhslink.cn/test\n", "utf8");
  const result = await importDownloadLinksFromSpreadsheet(filePath);
  assert.equal(result.importedCount, 2);
  assert.deepEqual(result.links.map((item) => item.platform), ["douyin", "xiaohongshu"]);
});
