import { createReadStream, createWriteStream } from 'node:fs';
import { stat, open, unlink, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import Video from '@alicloud/videoenhan20200320';
import Open from '@alicloud/openapi-client';
import Tea from '@alicloud/tea-util';
import Sts from '@alicloud/sts20150401';

export const ALIYUN_LIMIT_BYTES = 1024 ** 3;
export function validateRegion(region) {
  const value = Object.fromEntries(['BX', 'BY', 'BW', 'BH'].map(key => [key, region?.[key]]));
  if (Object.values(value).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)
    || value.BW <= 0 || value.BH <= 0 || value.BX + value.BW > 1.000001 || value.BY + value.BH > 1.000001) {
    throw new Error('字幕区域必须位于画面内，宽度和高度必须大于 0');
  }
  return value;
}

// SDK errors can include signed URLs and credentials. Never forward their raw text.
export function cloudErrorMessage(error) {
  const code = String(error?.code || '').split(':')[0];
  if (/InvalidAccessKey|SignatureDoesNotMatch|InvalidSecurityToken/.test(code)) return '密钥无效或签名失败，请检查 AccessKey ID 和 Secret';
  if (/Forbidden|Unauthorized|NoPermission/.test(code)) return '云服务拒绝访问，请确认已开通视频生产服务并授予视觉智能平台权限';
  if (/Balance|Arrearage|Pay|Quota/.test(code)) return '云服务余额或额度不足，请在控制台检查';
  if (/Throttl|LimitExceeded/.test(code)) return '云服务请求限流，请稍后再试';
  if (/InvalidParameter|InvalidFile|InvalidImage|InvalidVideo/.test(code)) return '云服务不接受该文件或区域参数，请检查视频格式与字幕区域';
  return '云服务请求未完成，请检查网络、服务开通状态和账户权限';
}

export function createAliyunClient(credentials) {
  const options = { ...credentials, regionId: 'cn-shanghai', protocol: 'https' };
  const client = new Video.default(new Open.Config({ ...options, endpoint: 'videoenhan.cn-shanghai.aliyuncs.com' }));
  const runtime = () => new Tea.RuntimeOptions({ autoretry: false, maxAttempts: 1, connectTimeout: 15000, readTimeout: 120000 });
  return {
    async verify() {
      const sts = new Sts.default(new Open.Config({ ...options, endpoint: 'sts.cn-shanghai.aliyuncs.com' }));
      await sts.getCallerIdentityWithOptions(runtime());
    },
    async submit(filePath, region) {
      const stream = createReadStream(filePath);
      try {
        const response = await client.eraseVideoSubtitlesAdvance(new Video.EraseVideoSubtitlesAdvanceRequest({ ...validateRegion(region), videoUrlObject: stream }), runtime());
        if (!response.body?.requestId) throw new Error('Missing request ID');
        return response.body.requestId;
      } finally { stream.destroy(); }
    },
    async query(jobId) {
      const response = await client.getAsyncJobResultWithOptions(new Video.GetAsyncJobResultRequest({ jobId }), runtime());
      const data = response.body?.data;
      if (!data?.status) throw new Error('Missing job status');
      return data;
    },
  };
}

export async function probeVideo(filePath, ffmpeg, { input = true } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.mp4') throw new Error('请选择本地 MP4 视频');
  const info = await stat(filePath);
  if (!info.isFile() || !info.size || (input && info.size > ALIYUN_LIMIT_BYTES)) throw new Error('视频不能为空，上传文件不能超过 1 GB');
  const handle = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(12);
    await handle.read(head, 0, head.length, 0);
    if (head.toString('ascii', 4, 8) !== 'ftyp') throw new Error('文件内容不是可识别的 MP4 视频');
  } finally { await handle.close(); }
  if (!ffmpeg) throw new Error('未找到视频检测工具，请重新安装完整软件');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', filePath], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('视频检测超时')); }, 20000);
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536); });
    child.stdout.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动视频检测工具')); });
    child.on('close', () => { clearTimeout(timer); resolve(stderr); });
  });
  const duration = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = output.match(/Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  if (!duration || !dimensions) throw new Error('视频无法读取，请确认文件完整且包含视频画面');
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  const width = Number(dimensions[1]), height = Number(dimensions[2]);
  if (!seconds || (input && (Math.max(width, height) > 1920 || Math.min(width, height) > 1080))) throw new Error('上传视频分辨率不得超过 1080P（横屏 1920×1080 或竖屏 1080×1920）');
  return { path: filePath, name: path.basename(filePath), sizeBytes: info.size, modifiedAt: info.mtimeMs, duration: seconds, width, height };
}

export function safeResultUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !url.hostname.endsWith('.aliyuncs.com')) throw new Error('云服务返回了无法识别的下载地址');
  // OSS signatures do not bind the protocol. Always transport the signed URL over TLS.
  url.protocol = 'https:';
  return url.href;
}

export async function downloadAliyunResult(url, destination, { fetchImpl = fetch, probe, signal } = {}) {
  let current = safeResultUrl(url), response;
  for (let count = 0; count < 5; count++) {
    response = await fetchImpl(current, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    current = safeResultUrl(new URL(response.headers.get('location'), current).href);
  }
  if (!response?.ok || !response.body) throw new Error('成片下载失败，临时地址可能已过期；请重新查询下载');
  const temp = `${destination}.${randomUUID()}.part.mp4`;
  let size = 0;
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > 4 * 1024 ** 3) return callback(new Error('成片超过本机下载大小限制'));
    hash.update(chunk); callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp, { flags: 'wx' }), { signal });
    const length = Number(response.headers.get('content-length'));
    if (!size || (length > 0 && length !== size)) throw new Error('成片下载不完整');
    await probe(temp, { input: false });
    await rename(temp, destination);
    return { sizeBytes: size, sha256: hash.digest('hex') };
  } finally { await unlink(temp).catch(() => {}); }
}
