import assert from "node:assert/strict";
import test from "node:test";
import { inspectViralDataCsv, parseViralDataCsv } from "../electron/viral-library-csv.mjs";
import { matchViralVisualCsv } from "../app/viral-visual-csv.mjs";

test("画面数据 CSV 保留任意数据列并可自选匹配列", () => {
  const source = '素材文件,消耗,ROI,备注\nclip.mp4,123.45,2.5,"带逗号,的内容"\nimage.png,0,,图片';
  const inspection = inspectViralDataCsv(source);
  assert.equal(inspection.matchColumn, 0);
  assert.equal(inspection.rowCount, 2);
  const result = parseViralDataCsv(source, 0);
  assert.deepEqual(result.rows[0].fields, [
    { name: "消耗", value: "123.45" },
    { name: "ROI", value: "2.5" },
    { name: "备注", value: "带逗号,的内容" },
  ]);
  assert.deepEqual(matchViralVisualCsv(["/media/clip.mp4", "/media/image.png"], result.rows).matches.map((item) => item.row.rowNumber), [2, 3]);
});

test("画面数据 CSV 默认优先选择四个投放指标", () => {
  const source = "素材文件,备注,3秒完播率,成交金额,整体支付roi,消耗,播放量\nclip.mp4,测试,45%,230,2.3,100,999";
  const inspection = inspectViralDataCsv(source);
  assert.deepEqual(inspection.displayColumns, [5, 4, 3, 2]);
  assert.deepEqual(parseViralDataCsv(source, 0).rows[0].fields, [
    { name: "消耗", value: "100" },
    { name: "整体支付roi", value: "2.3" },
    { name: "成交金额", value: "230" },
    { name: "3秒完播率", value: "45%" },
  ]);
});

test("画面数据 CSV 可只保留选中展示字段并单独读取文案列", () => {
  const source = "素材文件,消耗,ROI,完整文案,备注\nclip.mp4,123.45,2.5,这是口播文案,不展示";
  const inspection = inspectViralDataCsv(source);
  assert.equal(inspection.matchColumn, 0);
  assert.equal(inspection.copyColumn, 3);
  const result = parseViralDataCsv(source, 0, { displayColumns: [1, 2], copyColumn: 3 });
  assert.deepEqual(result.rows[0].fields, [
    { name: "消耗", value: "123.45" },
    { name: "ROI", value: "2.5" },
  ]);
  assert.equal(result.rows[0].copyText, "这是口播文案");
  assert.doesNotMatch(JSON.stringify(result.rows[0].fields), /不展示|这是口播文案/);
});

test("画面类型列可直接拆分为本地标签且不混入外显数据", () => {
  const source = "素材文件,画面类型,消耗,ROI\nclip.mp4,产品特写/场景应用,100,2.5";
  const inspection = inspectViralDataCsv(source);
  assert.equal(inspection.visualTypeColumn, 1);
  assert.doesNotMatch(inspection.displayColumns.map((index) => inspection.headers[index]).join(","), /画面类型/);
  const result = parseViralDataCsv(source, 0, { visualTypeColumn: 1 });
  assert.deepEqual(result.rows[0].visualTypes, ["产品特写", "场景应用"]);
});

test("没有画面类型列时返回空标签交由上传页自动识别", () => {
  const source = "素材文件,消耗\nclip.mp4,100";
  const inspection = inspectViralDataCsv(source);
  assert.equal(inspection.visualTypeColumn, -1);
  assert.deepEqual(parseViralDataCsv(source, 0).rows[0].visualTypes, []);
});

test("重复文件名、重复 CSV 行不自动误关联", () => {
  const row = (matchValue, rowNumber) => ({ matchValue, rowNumber, fields: [] });
  const duplicateFiles = matchViralVisualCsv(["/one/clip.mp4", "/two/clip.mp4"], [row("clip.mp4", 2)]);
  assert.equal(duplicateFiles.matches.length, 0);
  assert.equal(duplicateFiles.ambiguous.length, 2);
  const duplicateRows = matchViralVisualCsv(["/one/clip.mp4"], [row("clip.mp4", 2), row("clip.mp4", 3)]);
  assert.equal(duplicateRows.matches.length, 0);
  assert.equal(duplicateRows.ambiguous.length, 1);
  const exact = matchViralVisualCsv(["C:\\media\\clip.mp4"], [row("C:/media/clip.mp4", 2)]);
  assert.equal(exact.matches.length, 1);
});

test("缺少匹配列时拒绝数据导入", () => {
  assert.throws(() => parseViralDataCsv("消耗,ROI\n10,2", -1), /请选择 CSV/);
  assert.throws(() => inspectViralDataCsv("只有表头"), /至少需要表头/);
});
