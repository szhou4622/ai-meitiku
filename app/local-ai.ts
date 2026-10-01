const MODEL_ID = "Xenova/clip-vit-base-patch32";
const MODEL_REVISION = "d15189d7028b43f1d3e65039190477f6af591c2a";
const MODEL_CACHE_NAME = "transformers-cache";
const BUNDLED_MODEL_ROUTE = "/__local_visual_model/";

export type LocalClipCacheState = "unsupported" | "empty" | "partial" | "complete";

export type LocalClipCacheInfo = {
  state: LocalClipCacheState;
  fileCount: number;
  hasTextModel: boolean;
  hasVisionModel: boolean;
};

type ProgressInfo = {
  status: string;
  progress?: number;
  file?: string;
};

type TensorLike = { data: Float32Array | number[] };

type ClipRuntime = {
  tokenizer: (text: string[], options: Record<string, unknown>) => unknown;
  processor: (image: unknown) => Promise<unknown>;
  textModel: (input: unknown) => Promise<{ text_embeds: TensorLike }>;
  visionModel: (input: unknown) => Promise<{ image_embeds: TensorLike }>;
  RawImage: { read: (input: Blob | HTMLCanvasElement) => Promise<unknown> };
  device: "webgpu" | "wasm";
};

let runtimePromise: Promise<ClipRuntime> | null = null;

function readableCacheUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export async function inspectLocalClipCache(): Promise<LocalClipCacheInfo> {
  if (typeof caches === "undefined") {
    return { state: "unsupported", fileCount: 0, hasTextModel: false, hasVisionModel: false };
  }

  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const requests = await cache.keys();
    const modelUrls = requests
      .map((request) => readableCacheUrl(request.url).toLowerCase())
      .filter((url) => url.includes(`/${MODEL_ID.toLowerCase()}/resolve/`));
    const hasTextModel = modelUrls.some((url) => url.includes("/onnx/text_model_quantized.onnx"));
    const hasVisionModel = modelUrls.some((url) => url.includes("/onnx/vision_model_quantized.onnx"));
    const state: LocalClipCacheState = hasTextModel && hasVisionModel
      ? "complete"
      : modelUrls.length
        ? "partial"
        : "empty";
    return { state, fileCount: modelUrls.length, hasTextModel, hasVisionModel };
  } catch {
    return { state: "unsupported", fileCount: 0, hasTextModel: false, hasVisionModel: false };
  }
}

function normalize(values: Float32Array | number[]): number[] {
  const vector = Array.from(values);
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function reportProgress(callback: (progress: number, file: string) => void) {
  return (info: ProgressInfo) => {
    if (info.status === "progress" && typeof info.progress === "number") {
      callback(Math.max(1, Math.round(info.progress)), info.file ?? "模型文件");
    }
  };
}

export async function loadLocalClip(
  callback: (progress: number, file: string) => void,
): Promise<ClipRuntime> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const transformers = await import("@huggingface/transformers");
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = `${window.location.origin}${BUNDLED_MODEL_ROUTE}`;
    // A damaged or manually removed bundled model must not make the feature
    // permanently unusable. Transformers.js will fall back to the pinned
    // public model files and keep them in the browser cache for later use.
    transformers.env.allowRemoteModels = true;
    transformers.env.useBrowserCache = typeof caches !== "undefined";
    const device: "webgpu" | "wasm" = "gpu" in navigator ? "webgpu" : "wasm";
    const progress_callback = reportProgress(callback);
    const shared = { progress_callback, revision: MODEL_REVISION };
    const modelOptions = { ...shared, device, dtype: "q8" as const };
    const [tokenizer, processor, textModel, visionModel] = await Promise.all([
      transformers.AutoTokenizer.from_pretrained(MODEL_ID, shared),
      transformers.AutoProcessor.from_pretrained(MODEL_ID, shared),
      transformers.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, modelOptions),
      transformers.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, modelOptions),
    ]);
    callback(100, "模型已就绪");
    return {
      tokenizer: tokenizer as unknown as ClipRuntime["tokenizer"],
      processor: processor as unknown as ClipRuntime["processor"],
      textModel: textModel as unknown as ClipRuntime["textModel"],
      visionModel: visionModel as unknown as ClipRuntime["visionModel"],
      RawImage: transformers.RawImage,
      device,
    };
  })().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

const promptTerms: Array<[RegExp, string]> = [
  [/猫|猫咪/g, "cat"], [/狗|小狗/g, "dog"], [/蓝莓/g, "blueberry"], [/水果/g, "fruit"],
  [/红酒|葡萄酒|酒杯/g, "wine"], [/工厂|车间/g, "factory"], [/人物|人像/g, "person"],
  [/产品|商品/g, "product"], [/户外/g, "outdoor"], [/室内/g, "indoor"], [/汽车/g, "car"],
];

function visualPrompt(query: string): string {
  let rewritten = query.trim().toLowerCase();
  for (const [pattern, term] of promptTerms) rewritten = rewritten.replace(pattern, ` ${term} `);
  return `a photo of ${rewritten.replace(/\s+/g, " ").trim()}`;
}

export async function embedText(query: string, runtime: ClipRuntime): Promise<number[]> {
  const input = runtime.tokenizer([visualPrompt(query)], { padding: true, truncation: true });
  const output = await runtime.textModel(input);
  return normalize(output.text_embeds.data);
}

async function videoFrameCanvas(url: string): Promise<HTMLCanvasElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("video-frame-unavailable"));
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, video.videoWidth);
  canvas.height = Math.max(1, video.videoHeight);
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  video.removeAttribute("src");
  video.load();
  return canvas;
}

async function videoFrameCanvases(url: string, fractions = [0.12, 0.5, 0.85]): Promise<HTMLCanvasElement[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("video-frame-unavailable"));
  });
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const targets = duration > 0
    ? [...new Set(fractions.map((fraction) => Math.min(Math.max(0, duration * fraction), Math.max(0, duration - 0.05))).map((value) => value.toFixed(3)))]
    : ["0"];
  const canvases: HTMLCanvasElement[] = [];
  for (const target of targets) {
    const seconds = Number(target);
    if (Math.abs(video.currentTime - seconds) > 0.02) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { video.onseeked = null; video.onerror = null; };
        video.onseeked = () => { cleanup(); resolve(); };
        video.onerror = () => { cleanup(); reject(new Error("video-frame-unavailable")); };
        video.currentTime = seconds;
      });
    }
    const scale = Math.min(1, 720 / Math.max(1, video.videoWidth));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvases.push(canvas);
  }
  video.removeAttribute("src");
  video.load();
  return canvases;
}

export async function embedVisual(
  url: string,
  type: "image" | "video",
  runtime: ClipRuntime,
): Promise<number[]> {
  const inputSource = type === "video" ? await videoFrameCanvas(url) : await (await fetch(url)).blob();
  const image = await runtime.RawImage.read(inputSource);
  const input = await runtime.processor(image);
  const output = await runtime.visionModel(input);
  return normalize(output.image_embeds.data);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) score += a[index] * b[index];
  return score;
}

const viralVisualPrompts = [
  ["痛点展示", "an advertisement showing a person's problem, discomfort, frustration, inconvenience or negative state before using a product"],
  ["使用演示", "hands or a person clearly demonstrating how to operate, prepare or use a product step by step"],
  ["效果对比", "a before and after comparison or side by side comparison clearly showing different results"],
  ["产品特写", "a close-up commercial product shot focused on packaging, material, texture, details or contents"],
  ["场景应用", "a product shown in a real life home, office, commuting, outdoor, party or daily use scene"],
  ["价格促单钩子", "a promotional sale poster dominated by price, discount, coupon, limited time offer, gift or buy now call to action"],
  ["证言共鸣", "a customer testimonial, review screenshot, interview, personal story, social proof or audience empathy advertisement"],
] as const;

let viralVisualTextEmbeddingsPromise: Promise<Array<{ visualType: string; embedding: number[] }>> | null = null;

async function viralVisualTextEmbeddings(runtime: ClipRuntime) {
  if (!viralVisualTextEmbeddingsPromise) {
    viralVisualTextEmbeddingsPromise = Promise.all(viralVisualPrompts.map(async ([visualType, prompt]) => ({
      visualType,
      embedding: await embedText(prompt, runtime),
    }))).catch((error) => {
      viralVisualTextEmbeddingsPromise = null;
      throw error;
    });
  }
  return viralVisualTextEmbeddingsPromise;
}

function averageEmbeddings(embeddings: number[][]): number[] {
  if (!embeddings.length) return [];
  const length = Math.min(...embeddings.map((embedding) => embedding.length));
  const average = Array.from({ length }, (_, index) => embeddings.reduce((sum, embedding) => sum + embedding[index], 0) / embeddings.length);
  return normalize(average);
}

export async function classifyViralVisualLocally(
  url: string,
  type: "image" | "video",
  onProgress: (progress: number, file: string) => void = () => {},
): Promise<{ visualType: string; confidence: number; reason: string }> {
  const runtime = await loadLocalClip(onProgress);
  const sources = type === "video" ? await videoFrameCanvases(url) : [await (await fetch(url)).blob()];
  const visualEmbeddings: number[][] = [];
  for (const source of sources) {
    const image = await runtime.RawImage.read(source);
    const input = await runtime.processor(image);
    const output = await runtime.visionModel(input);
    visualEmbeddings.push(normalize(output.image_embeds.data));
  }
  const visualEmbedding = averageEmbeddings(visualEmbeddings);
  const scores = (await viralVisualTextEmbeddings(runtime))
    .map((candidate) => ({ visualType: candidate.visualType, score: cosineSimilarity(visualEmbedding, candidate.embedding) }))
    .sort((left, right) => right.score - left.score);
  const best = scores[0];
  const second = scores[1];
  const logits = scores.map((item) => Math.exp((item.score - best.score) / 0.035));
  const confidence = 1 / logits.reduce((sum, value) => sum + value, 0);
  if (!best || best.score < 0.16 || best.score - (second?.score ?? 0) < 0.012 || confidence < 0.28) {
    return { visualType: "人工标注", confidence, reason: "本地模型无法高置信度判断" };
  }
  return { visualType: best.visualType, confidence, reason: `本地模型匹配度 ${best.score.toFixed(3)}` };
}

export const localClipModel = {
  id: MODEL_ID,
  label: "CLIP ViT-B/32 · Q8",
  approximateSize: "约 150 MB",
  bundled: true,
};
