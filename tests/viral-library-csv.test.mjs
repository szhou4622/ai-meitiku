import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { decodeCsvBuffer, inspectViralLibraryCsv, parseCsvRows, parseViralLibraryCsv } from "../electron/viral-library-csv.mjs";

test("CSV 支持引号、逗号和换行文案", () => {
  const rows = parseCsvRows('关联ID,画面,文案\nA1,clip.mp4,"第一句,带逗号\n第二句"');
  assert.equal(rows[1][2], "第一句,带逗号\n第二句");
});

test("CSV 同行画面和文案保留关联编号并解析相对路径", () => {
  const csvPath = path.join(path.sep, "project", "import.csv");
  const rows = parseViralLibraryCsv('关联ID,画面路径,文案,分类\nA1,media/clip.mp4,开场口播,开头钩子\nA2,,独立脚本,痛点共鸣', csvPath);
  assert.equal(rows[0].mediaPath, path.join(path.sep, "project", "media", "clip.mp4"));
  assert.equal(rows[0].associationId, "A1");
  assert.equal(rows[1].mediaPath, "");
  assert.equal(rows[1].copy, "独立脚本");
  assert.deepEqual(rows[0].classifications, [{ field: "分类", value: "开头钩子" }]);
});

test("大分类从独立列读取，不混入文案的多字段细分类", () => {
  const source = "画面,文案,大分类,表现分类\nclip.mp4,一句文案,自定义组,开头";
  const inspection = inspectViralLibraryCsv(source);
  assert.equal(inspection.columns.majorCategory, 2);
  assert.deepEqual(inspection.columns.category, [3]);
  const [row] = parseViralLibraryCsv(source, "/project/import.csv");
  assert.equal(row.majorCategory, "自定义组");
  assert.deepEqual(row.classifications, [{ field: "表现分类", value: "开头" }]);
});

test("同一 CSV 列不能同时映射为大分类和细分类", () => {
  const source = "文案,大分类\n第一句,产品组";
  assert.throws(() => parseViralLibraryCsv(source, "/project/import.csv", {
    media: -1, copy: 0, associationId: -1, category: [1], data: [], majorCategory: 1, title: -1,
  }), /不能同时作为大分类和细分类/);
});

test("用户可选择多列任意表头作为分类，保留每列字段名与行值", () => {
  const source = "文案,商品类目,内容形式,创意标签\n第一句,酸菜,口播,促单\n第二句,食品,,种草";
  const csvPath = path.join(path.sep, "project", "import.csv");
  const inspected = inspectViralLibraryCsv(source);
  assert.deepEqual(inspected.columns.category, [1, 3]);
  const rows = parseViralLibraryCsv(source, csvPath, { media: -1, copy: 0, associationId: -1, category: [1, 2, 3], title: -1 });
  assert.deepEqual(rows[0].classifications, [
    { field: "商品类目", value: "酸菜" }, { field: "内容形式", value: "口播" }, { field: "创意标签", value: "促单" },
  ]);
  assert.deepEqual(rows[1].classifications, [
    { field: "商品类目", value: "食品" }, { field: "创意标签", value: "种草" },
  ]);
  assert.equal(rows[0].category, "酸菜");
  const legacyMapping = parseViralLibraryCsv(source, csvPath, { media: -1, copy: 0, associationId: -1, category: 2, title: -1 });
  assert.deepEqual(legacyMapping[0].classifications, [{ field: "内容形式", value: "口播" }]);
});

test("文案 CSV 数据字段默认推荐四项并允许手动增减", () => {
  const source = "文案,作者,消耗,整体支付ROI,成交金额,3秒播放率,播放\n第一句,阿忠,100,2.3,230,45%,12万";
  const inspected = inspectViralLibraryCsv(source);
  assert.deepEqual(inspected.columns.data, [2, 3, 4, 5]);
  const [row] = parseViralLibraryCsv(source, "/project/import.csv", {
    media: -1, copy: 0, associationId: -1, category: [], data: [1, 4], majorCategory: -1, title: -1,
  });
  assert.deepEqual(row.dataFields, [{ name: "作者", value: "阿忠" }, { name: "成交金额", value: "230" }]);
  const [withoutData] = parseViralLibraryCsv(source, "/project/import.csv", {
    media: -1, copy: 0, associationId: -1, category: [], data: [], majorCategory: -1, title: -1,
  });
  assert.deepEqual(withoutData.dataFields, []);
});

test("分类字段超过上限时在导入前拒绝", () => {
  const headers = ["文案", ...Array.from({ length: 25 }, (_, index) => `分类${index + 1}`)];
  const source = `${headers.join(",")}\n${["内容", ...Array.from({ length: 25 }, () => "标签")].join(",")}`;
  assert.throws(() => parseViralLibraryCsv(source, "/project/import.csv", {
    media: -1, copy: 0, associationId: -1, category: Array.from({ length: 25 }, (_, index) => index + 1), title: -1,
  }), /最多选择 24 个分类字段/);
});

test("CSV 支持 UTF-16LE BOM", () => {
  const source = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("文案\r\n测试", "utf16le")]);
  assert.match(decodeCsvBuffer(source), /测试/);
});

test("任意表头可通过用户字段映射导入", () => {
  const csvPath = path.join(path.sep, "project", "import.csv");
  const source = "素材地址,台词内容,我的编号\nmedia/clip.mp4,用户自选的文案,A-9";
  const inspected = inspectViralLibraryCsv(source);
  assert.deepEqual(inspected.headers, ["素材地址", "台词内容", "我的编号"]);
  assert.equal(inspected.columns.media, -1);
  const rows = parseViralLibraryCsv(source, csvPath, { media: 0, copy: 1, associationId: 2, category: -1, title: -1 });
  assert.equal(rows[0].mediaPath, path.join(path.sep, "project", "media", "clip.mp4"));
  assert.equal(rows[0].copy, "用户自选的文案");
  assert.equal(rows[0].associationId, "A-9");
  assert.deepEqual(rows[0].classifications, []);
});

test("字段映射必须选择画面路径或文案", () => {
  assert.throws(() => parseViralLibraryCsv("列1,列2\na,b", "/project/import.csv", {
    media: -1, copy: -1, associationId: 0, category: -1, title: -1,
  }), /至少选择/);
});
