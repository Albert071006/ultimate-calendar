import { createHash } from 'node:crypto';
import { DistilledItemSchema } from '../shared/distilled';
import { z } from 'zod';

export type DistilledItem = z.infer<typeof DistilledItemSchema>;
export interface SafeDistillation { item: DistilledItem; hash: string }
export type Projection = { ok: true; value: SafeDistillation } | { ok: false; reason: 'privacy' | 'schema' };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export const distilledHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const normalize = (value: unknown): unknown => typeof value === 'string' ? value.normalize('NFC').trim() : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)])) : value;
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}
/** Fail closed instead of silently deleting conditions or truncating actionable information. */
export function containsPrivateMaterial(value: unknown, privateTokens: readonly string[] = []): boolean {
  return strings(value).some(text => {
    if (/(?:[a-z]:[\\/]|\\\\|\bfile:|\bdata:|\bblob:|https?:\/\/|wss?:\/\/|\[CQ:|\/(?:Users|home|tmp|var|mnt)\/)/i.test(text)) return true;
    if (/\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|zip|rar|7z|mp[34])(?:\b|$)/i.test(text)) return true;
    if (/(?:QQ|群号|账号|帐号|[Qq]群)\s*[:：号为是]?\s*\d{5,}/i.test(text)) return true;
    return privateTokens.some(token => {
      if (!token) return false;
      if (!/^\d+$/.test(token)) return text.includes(token);
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^0-9])${escaped}(?:$|[^0-9])`).test(text);
    });
  });
}
/** Input must already be the SQL whitelist projection, never a full candidate or source payload. */
export function projectDistilledFields(value: unknown, privateTokens: readonly string[] = []): Projection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'schema' };
  const normalized = normalize(value);
  if (containsPrivateMaterial(normalized, privateTokens)) return { ok: false, reason: 'privacy' };
  const parsed = DistilledItemSchema.safeParse({ distilledId: 'temporary-stable-id', ...(normalized as object) });
  if (!parsed.success) return { ok: false, reason: 'schema' };
  const { distilledId: _discard, ...fields } = parsed.data; const hash = distilledHash(fields);
  return { ok: true, value: { item: { ...fields, distilledId: `qqd_${hash}` }, hash } };
}
