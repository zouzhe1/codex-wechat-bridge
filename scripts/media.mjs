import fs from 'node:fs/promises';
import path from 'node:path';
import { classify } from './channel.mjs';

const SAFE = /[^\w.一-龥-]/g;

function sniffExt(bytes) {
  if (bytes.length < 12) return '';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return '.gif';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE') return '.wav';
  if (bytes.toString('latin1', 4, 8) === 'ftyp') return '.mp4';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44) return '.pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return '.zip';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return '.gz';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return '.doc';
  return '';
}

/**
 * Download media descriptors to `<state>/media/` and attach local paths.
 * Runs in the consume loop — never inside the poll handler, so receiving
 * stays live while a big file downloads.
 */
export async function hydrateMedia(channel, store, item) {
  if (!Array.isArray(item.media) || item.media.length === 0) return item;
  const dir = path.join(store.directory, 'media');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let n = 0;
  for (const m of item.media) {
    n += 1;
    if (!m.media || m.path) continue;
    try {
      const bytes = await channel.downloadMedia(m.media);
      const base = String(m.name || m.kind || 'file').replace(SAFE, '_').slice(0, 60) || m.kind || 'file';
      const hasExt = /\.[a-z0-9]{2,5}$/i.test(base);
      const finalName = `${item.id.slice(0, 16)}-${n}${hasExt ? base : base + (sniffExt(bytes) || '')}`;
      const p = path.join(dir, finalName);
      await fs.writeFile(p, bytes, { mode: 0o600 });
      m.path = p;
      m.size = bytes.length;
    } catch (e) {
      m.error = classify(e).code;
    }
    delete m.media; // CDN payload no longer needed once bytes are local (or failed)
  }
  return item;
}

/** Media-only messages become a prompt the model can act on. */
export function mediaPrompt(item) {
  const lines = (item.media || []).map(m => m.path
    ? `- ${m.path}(${{ image: '图片', file: '文件', video: '视频' }[m.kind] || m.kind})`
    : `- (${m.kind} 下载失败: ${m.error || '未知错误'})`);
  if (!lines.length) return '';
  return `用户从微信发来了媒体文件:\n${lines.join('\n')}\n\n请查看内容(图片可直接读取)并按需处理,完成后简要汇报。`;
}
