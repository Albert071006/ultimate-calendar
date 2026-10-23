import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';
import { extname } from 'node:path';
import { isBridgeAttachmentLocation, type BridgeAttachmentLocation } from './bridge';

const MAX_BYTES = 25 * 1024 * 1024;
const EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.md', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const EXACT_HOSTS = new Set(['gchat.qpic.cn', 'gzc.qpic.cn', 'c2cpicdw.qpic.cn', 'c2cpicdw.qpic.cn', 'multimedia.nt.qq.com.cn', 'multimedia.nt.qq.com', 'grouptalk.c2c.qq.com']);
const HOST_SUFFIXES = ['.ftn.qq.com', '.ftn.qq.com.cn', '.file.qq.com'];
export type AttachmentDownloadOptions = { fileName: string; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal };
/** Only fixed application diagnostics use this type; network exception text is never promoted. */
export class AttachmentDownloadError extends Error {
  constructor(message: string, readonly status: 'failed' | 'unsupported' | 'too-large' = 'failed') { super(message); }
}

export function isPublicAttachmentAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a !== undefined && b !== undefined && c !== undefined && a > 0 && a < 224
      && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
      && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
  }
  if (family !== 6) return false;
  const first = Number.parseInt(address.split(':')[0]!, 16), normalized = address.toLowerCase();
  return first >= 0x2000 && first <= 0x3fff && !normalized.startsWith('2002:')
    && !/^2001:(?:0*:|0*2:|0*db8:|0*1[0-9a-f]:|0*2[0-9a-f]:)/.test(normalized);
}

/** Only known QQ media hosts are accepted. HTTP image links are upgraded before any request. */
export function validateAttachmentUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AttachmentDownloadError('QQ 附件地址格式不正确'); }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || url.hash || (url.port && url.port !== '443') || !['http:', 'https:'].includes(url.protocol)
    || !(EXACT_HOSTS.has(host) || HOST_SUFFIXES.some(suffix => host.endsWith(suffix)))) throw new AttachmentDownloadError('QQ 附件地址不在允许的公开资源域中');
  if (url.protocol === 'http:') {
    if (!['gchat.qpic.cn', 'gzc.qpic.cn', 'c2cpicdw.qpic.cn'].includes(host)) throw new AttachmentDownloadError('QQ 附件必须通过 HTTPS 下载');
    url.protocol = 'https:';
  }
  return url;
}

async function withSignal<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AttachmentDownloadError('附件下载已取消或超时');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AttachmentDownloadError('附件下载已取消或超时'));
    signal.addEventListener('abort', abort, { once: true });
    value.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function openResponse(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const addresses = await withSignal(lookup(url.hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some(item => !isPublicAttachmentAddress(item.address))) throw new AttachmentDownloadError('QQ 附件地址解析到了非公开网络，已停止下载');
  // Pin the validated DNS result for this request; HTTPS still verifies the original hostname.
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, { method: 'GET', signal, lookup: pinnedLookup, headers: { 'User-Agent': 'UltimateCalendar-Attachment/1', Accept: '*/*' } }, resolve);
    req.once('error', reject);
    req.end();
  });
}

/** Pass the original frozen locator returned by bridge.getFileUrl/getImage; cloned or renderer input is rejected. */
export async function downloadAttachment(location: BridgeAttachmentLocation, options: AttachmentDownloadOptions): Promise<Buffer> {
  if (!isBridgeAttachmentLocation(location)) throw new AttachmentDownloadError('附件下载必须来自已授权 QQ 消息的桥接查询');
  if (!options.fileName || options.fileName.length > 512 || !EXTENSIONS.has(extname(options.fileName).toLowerCase())) throw new AttachmentDownloadError('此附件格式暂不支持自动分析', 'unsupported');
  const maxBytes = options.maxBytes ?? MAX_BYTES, timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new AttachmentDownloadError('附件下载限额不正确');
  // The installed SnowLuma resolves its in-memory media cache to QQ HTTPS URLs. No on-disk
  // attachment cache root has been verified; allowing its account/data directory would expose secrets.
  if (!location.url) throw new AttachmentDownloadError(location.path ? '桥接返回了本机文件路径，但尚无已验证的附件缓存目录，请手动查看原文件' : 'QQ 尚未提供可下载的附件地址');
  let current = validateAttachmentUrl(location.url);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  try {
    for (let redirect = 0; redirect <= 3; redirect++) {
      if (signal.aborted) throw new AttachmentDownloadError('附件下载已取消或超时');
      const response = await openResponse(current, signal);
      const code = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code)) {
        response.resume();
        if (!response.headers.location || redirect === 3) throw new AttachmentDownloadError('QQ 附件跳转过多或缺少地址');
        const next = new URL(response.headers.location, current);
        if (next.protocol !== 'https:') throw new AttachmentDownloadError('QQ 附件跳转未使用 HTTPS，已停止下载');
        current = validateAttachmentUrl(next.toString());
        continue;
      }
      if (code !== 200) { response.resume(); throw new AttachmentDownloadError([401, 403, 404, 410].includes(code) ? 'QQ 附件链接已过期或无法访问，请重新获取' : 'QQ 附件下载失败，请稍后重试'); }
      const length = response.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { response.destroy(); throw new AttachmentDownloadError('附件超过自动下载的大小上限', 'too-large'); }
      if (/text\/html/i.test(response.headers['content-type'] ?? '')) { response.destroy(); throw new AttachmentDownloadError('QQ 返回了网页而非附件，请重新获取链接'); }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const part of response) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
        size += bytes.length;
        if (size > maxBytes) { response.destroy(); throw new AttachmentDownloadError('附件超过自动下载的大小上限', 'too-large'); }
        chunks.push(bytes);
      }
      if (!size) throw new AttachmentDownloadError('QQ 附件为空');
      return Buffer.concat(chunks, size);
    }
    throw new AttachmentDownloadError('QQ 附件跳转过多');
  } catch (error) {
    if (signal.aborted) throw new AttachmentDownloadError('附件下载已取消或超时');
    if (error instanceof AttachmentDownloadError) throw error;
    throw new AttachmentDownloadError('QQ 附件下载失败，请检查连接后重试');
  }
}
