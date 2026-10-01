import assert from "node:assert/strict";
import test from "node:test";
import { matchesViralLibrarySearch } from "../app/viral-library-search.mjs";

test("画面和文案搜索支持空白、大小写与非连续字符", () => {
  assert.equal(matchesViralLibrarySearch("", ["任意素材"]), true);
  assert.equal(matchesViralLibrarySearch("ABC", ["a-b c"]), true);
  assert.equal(matchesViralLibrarySearch("画文", ["画面和文案"]), true);
  assert.equal(matchesViralLibrarySearch("不相关", ["画面和文案"]), false);
});
