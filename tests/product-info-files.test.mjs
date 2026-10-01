import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  extractProductInfoFiles,
  extractScannedProductInfoFiles,
  htmlToProductInfoText,
  pdfBmpToPng,
  PRODUCT_INFO_SUPPORTED_EXTENSIONS,
} from "../electron/product-info-files.mjs";

function minimalPptx(text) {
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    "ppt/presentation.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`),
    "ppt/slides/slide1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
  };
  return Buffer.from(zipSync(files));
}

function onePixelBmp(red = 20, green = 40, blue = 60) {
  const buffer = Buffer.alloc(58);
  buffer.write("BM", 0);
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(-1, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(0, 30);
  buffer.writeUInt32LE(4, 34);
  buffer[54] = blue;
  buffer[55] = green;
  buffer[56] = red;
  return buffer;
}

test("supports common product information formats", () => {
  for (const extension of [".ppt", ".pptx", ".jpg", ".png", ".html", ".pdf", ".docx", ".xlsx", ".txt", ".md", ".csv"]) {
    assert.equal(PRODUCT_INFO_SUPPORTED_EXTENSIONS.has(extension), true, extension);
  }
});

test("removes scripts and keeps visible HTML product information", () => {
  const text = htmlToProductInfoText(`<html><script>steal()</script><h1>宠物冻干</h1><p>核心卖点：高蛋白</p></html>`);
  assert.match(text, /宠物冻干/);
  assert.match(text, /高蛋白/);
  assert.doesNotMatch(text, /steal/);
});

test("extracts and combines PPTX, HTML, text, and vision image results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "product-info-files-"));
  try {
    const pptxPath = path.join(root, "产品介绍.pptx");
    const htmlPath = path.join(root, "详情页.html");
    const textPath = path.join(root, "补充说明.txt");
    const imagePath = path.join(root, "包装.png");
    await writeFile(pptxPath, minimalPptx("宝迪路拿铁小方宠物冻干"));
    await writeFile(htmlPath, `<h1>兔血冻干</h1><p>使用场景：训练奖励</p>`);
    await writeFile(textPath, "目标人群：养猫家庭");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await extractProductInfoFiles([pptxPath, htmlPath, textPath, imagePath], {
      analyzeImage: async (filePath, mimeType) => {
        assert.equal(filePath, imagePath);
        assert.equal(mimeType, "image/png");
        return "包装信息：拿铁小方；净含量 50g";
      },
    });
    assert.equal(result.files.length, 4);
    assert.equal(result.warnings.length, 0);
    assert.match(result.text, /宝迪路拿铁小方宠物冻干/);
    assert.match(result.text, /训练奖励/);
    assert.match(result.text, /养猫家庭/);
    assert.match(result.text, /净含量 50g/);
    assert.match(result.text, /【产品资料：产品介绍\.pptx】/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps readable files when another selected file cannot be parsed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "product-info-partial-"));
  try {
    const goodPath = path.join(root, "产品.txt");
    const badPath = path.join(root, "损坏.pdf");
    await writeFile(goodPath, "产品名称：测试产品");
    await writeFile(badPath, "not a pdf");
    const result = await extractProductInfoFiles([goodPath, badPath]);
    assert.equal(result.files.length, 1);
    assert.equal(result.warnings.length, 1);
    assert.match(result.text, /测试产品/);
    assert.match(result.warnings[0], /损坏\.pdf/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns scanned PDF as a manual AI candidate without calling vision automatically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "product-info-scanned-candidate-"));
  try {
    const pdfPath = path.join(root, "扫描产品册.pdf");
    await writeFile(pdfPath, "%PDF scanned placeholder");
    let visionCalls = 0;
    const result = await extractProductInfoFiles([pdfPath], {
      analyzeImage: async () => { visionCalls += 1; return "不应自动调用"; },
      parseOffice: async () => ({ to: async () => ({ value: "   " }) }),
    });
    assert.equal(visionCalls, 0);
    assert.equal(result.text, "");
    assert.equal(result.files.length, 0);
    assert.equal(result.scanCandidates.length, 1);
    assert.equal(result.scanCandidates[0].path, pdfPath);
    assert.match(result.scanCandidates[0].reason, /AI 识别扫描件/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps readable PDF text and reports only unread scanned pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "product-info-hybrid-pdf-"));
  try {
    const pdfPath = path.join(root, "混合产品册.pdf");
    await writeFile(pdfPath, "%PDF hybrid placeholder");
    const result = await extractProductInfoFiles([pdfPath], {
      parseOffice: async (_filePath, options) => {
        assert.equal(options.extractAttachments, true);
        return {
          content: [
            { type: "page", text: "产品名称：混合 PDF 产品", metadata: { pageNumber: 1 } },
            { type: "page", text: "", metadata: { pageNumber: 2 } },
            { type: "page", text: "核心卖点：稳定耐用", metadata: { pageNumber: 3 } },
          ],
          attachments: [{ name: "pdf_image_p2_1.bmp", mimeType: "image/bmp", data: onePixelBmp().toString("base64") }],
          to: async () => ({ value: "产品名称：混合 PDF 产品\n核心卖点：稳定耐用" }),
        };
      },
    });
    assert.equal(result.files.length, 1);
    assert.equal(result.documents.length, 1);
    assert.match(result.text, /混合 PDF 产品/);
    assert.equal(result.scanCandidates.length, 1);
    assert.deepEqual(result.scanCandidates[0].pages, [2]);
    assert.equal(result.scanCandidates[0].totalPages, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses a stable content fingerprint for duplicate product files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "product-info-deduplicate-"));
  try {
    const firstPath = path.join(root, "产品-A.txt");
    const secondPath = path.join(root, "产品-B.txt");
    await writeFile(firstPath, "产品名称：同一产品");
    await writeFile(secondPath, "产品名称：同一产品");
    const result = await extractProductInfoFiles([firstPath, secondPath]);
    assert.equal(result.files[0].sourceId, result.files[1].sourceId);
    assert.equal(result.documents[0].sourceId, result.documents[1].sourceId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("converts PDF BMP attachment to PNG and recognizes it only through explicit scan action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "product-info-scanned-ai-"));
  try {
    const pdfPath = path.join(root, "扫描产品册.pdf");
    await writeFile(pdfPath, "%PDF scanned placeholder");
    const bmp = onePixelBmp();
    const png = pdfBmpToPng(bmp);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const calls = [];
    const result = await extractScannedProductInfoFiles([pdfPath], {
      parseOffice: async (_filePath, options) => {
        assert.equal(options.extractAttachments, true);
        assert.equal(options.ocr, false);
        return { attachments: [{ name: "pdf_image_p1_1.bmp", mimeType: "image/bmp", data: bmp.toString("base64") }] };
      },
      analyzeImage: async (image, mimeType, context) => {
        calls.push({ image, mimeType, context });
        return "产品名称：扫描测试产品\n核心卖点：清晰可见";
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mimeType, "image/png");
    assert.equal(calls[0].context.source, "scanned-pdf");
    assert.equal(calls[0].context.page, 1);
    assert.equal(result.files[0].path, pdfPath);
    assert.match(result.text, /AI 识别扫描件/);
    assert.match(result.text, /扫描测试产品/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
