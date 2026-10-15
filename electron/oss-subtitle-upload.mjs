// Main process only. Signed URLs are short lived and never persisted or logged.
import { open, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const PART_SIZE = 8 * 1024 ** 2;
const fail = (code, message) => Object.assign(new Error(message), { code });
const unchanged = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

export async function uploadSubtitleDirect({ filePath, requestId = randomUUID(), request, fetchImpl = fetch, onProgress = () => {} }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.mp4')
    throw fail('INVALID_SUBTITLE_UPLOAD', '请选择本地 MP4 视频');
  const file = await open(filePath, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size || info.size > 1024 ** 3)
      throw fail('SUBTITLE_FILE_TOO_LARGE', '上传文件不能超过阿里云官方上限 1 GB');
    const hash = createHash('sha256'), md5 = [], buffer = Buffer.alloc(Math.min(PART_SIZE, info.size));
    const read = async number => {
      const offset = (number - 1) * PART_SIZE, length = Math.min(PART_SIZE, info.size - offset);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await file.read(buffer, done, length - done, offset + done);
        if (!bytesRead) throw fail('SUBTITLE_UPLOAD_CHANGED', '视频已变化，请重新添加');
        done += bytesRead;
      }
      return buffer.subarray(0, length);
    };
    for (let n = 1; n <= Math.ceil(info.size / PART_SIZE); n++) {
      const bytes = await read(n); hash.update(bytes); md5.push(createHash('md5').update(bytes).digest('hex'));
    }
    const sha256 = hash.digest('hex');
    if (!unchanged(info, await stat(filePath))) throw fail('SUBTITLE_UPLOAD_CHANGED', '视频已变化，请重新添加');
    const session = await request('init', { request_id: requestId, size_bytes: info.size, sha256, part_md5: md5 });
    if (session.transport !== 'oss-multipart' || session.part_size !== PART_SIZE || session.part_count !== md5.length
        || session.size_bytes !== info.size || session.sha256 !== sha256 || !/^[a-f0-9]{48}$/.test(session.upload_id || ''))
      throw fail('SUBTITLE_UPLOAD_UNVERIFIED', '直传初始化校验失败，本次未提交生成或扣分');
    let status = await request('status', { upload_id: session.upload_id });
    const validate = value => {
      if (value.upload_id !== session.upload_id || value.size_bytes !== info.size || value.sha256 !== sha256)
        throw fail('SUBTITLE_UPLOAD_UNVERIFIED', '上传文件校验失败，本次未提交生成或扣分');
    };
    validate(status);
    if (!Array.isArray(status.uploaded_parts) || status.uploaded_parts.some(n => !Number.isInteger(n) || n < 1 || n > md5.length))
      throw fail('SUBTITLE_UPLOAD_UNVERIFIED', '上传分片状态无效');
    const uploaded = new Set(status.uploaded_parts);
    let uploadedBytes = [...uploaded].reduce((total, n) => total + Math.min(PART_SIZE, info.size - (n-1)*PART_SIZE), 0);
    await onProgress({ uploadedBytes: status.completed ? info.size : uploadedBytes, totalBytes: info.size, resumedParts: uploaded.size });
    if (!status.completed) {
      for (let n = 1; n <= md5.length; n++) {
        if (uploaded.has(n)) continue;
        const bytes = await read(n);
        if (createHash('md5').update(bytes).digest('hex') !== md5[n-1] || !unchanged(info, await stat(filePath)))
          throw fail('SUBTITLE_UPLOAD_CHANGED', '视频已变化，请重新添加');
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          const signed = await request('part', { upload_id: session.upload_id, part_number: n });
          const url = new URL(signed.url);
          const expectedMD5 = Buffer.from(md5[n-1], 'hex').toString('base64');
          if (url.protocol !== 'https:' || url.hostname !== 'aiml-subtitle-temp-20261014.oss-cn-shanghai.aliyuncs.com'
              || url.username || url.password || url.port || !/^\/aiml-subtitles-temp\/[a-f0-9]{48}\.mp4$/.test(url.pathname)
              || url.searchParams.get('partNumber') !== String(n) || !url.searchParams.get('uploadId')
              || signed.upload_id !== session.upload_id || signed.part_number !== n
              || signed.headers?.['content-md5'] !== expectedMD5 || signed.headers?.['content-type'] !== 'application/octet-stream'
              || Object.keys(signed.headers).length !== 2)
            throw fail('SUBTITLE_UPLOAD_UNVERIFIED', '上传地址或分片校验无效');
          try {
            // Device credentials go only to our gateway, never to OSS.
            const response = await fetchImpl(url.href, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(5*60*1000),
              headers: { ...signed.headers, 'content-length': String(bytes.length) }, body: bytes });
            const etag = (response.headers.get('etag') || '').replaceAll('"', '').toLowerCase();
            await response.body?.cancel();
            if (!response.ok || etag !== md5[n-1]) throw new Error('unverified part');
            done = true;
          } catch {
            // Retrying the same part overwrites that part; it never creates a
            // paid inference task and safely handles a lost PUT response.
            if (attempt === 2) throw fail('SUBTITLE_UPLOAD_INTERRUPTED', '直传中断，已上传分片已保留；继续批次可恢复，本次未扣积分');
          }
        }
        uploadedBytes += bytes.length;
        await onProgress({ uploadedBytes, totalBytes: info.size, resumedParts: uploaded.size });
      }
      status = await request('complete', { upload_id: session.upload_id }); validate(status);
    }
    if (status.completed !== true || !(status.verified_seconds > 0) || !unchanged(info, await stat(filePath)))
      throw fail('SUBTITLE_UPLOAD_UNVERIFIED', '云端视频验证未通过，本次未提交生成或扣分');
    return status;
  } finally { await file.close(); }
}
