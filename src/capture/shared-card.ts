type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim().slice(0, 2000) : '';

function webUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

/** Read only the visible share-card fields; never execute or fetch the linked document. */
export function sharedCardText(segment: unknown): string {
  const part = object(segment);
  if (part.type !== 'json') return '';
  const raw = object(part.data).data;
  if (typeof raw !== 'string' || raw.length > 100_000) return '';
  let card: ObjectValue;
  try { card = object(JSON.parse(raw)); } catch { return ''; }
  const meta = object(card.meta);
  const detail = card.app === 'com.tencent.miniapp_01' ? object(meta.detail_1)
    : card.app === 'com.tencent.structmsg' ? object(meta.news) : null;
  if (!detail) return '';
  const title = text(detail.title), description = text(detail.desc);
  const prompt = text(card.prompt).replace(/^\[(?:QQ小程序|分享)\]\s*/, '');
  const lines = [...new Set([title, description, prompt].filter(Boolean))];
  // Prefer the document's ordinary web URL to a mini-program routing URL.
  const url = [detail.qqdocurl, detail.jumpUrl, detail.url].map(webUrl).find(Boolean);
  if (url) lines.push(url);
  return lines.length ? `[分享卡片]\n${lines.join('\n')}` : '';
}

/** Recover legacy stored cards for a new analysis without rewriting the captured message. */
export function effectiveMessageText(message: { text: string; segments: readonly unknown[] }): string {
  let result = message.text;
  for (const segment of message.segments) {
    if (object(segment).type !== 'json') continue;
    const card = sharedCardText(segment) || '[采集提示：分享卡片未取得可读标题或链接，请手动查看]';
    if (!result.includes(card)) result = [result, card].filter(Boolean).join('\n');
  }
  return result;
}
