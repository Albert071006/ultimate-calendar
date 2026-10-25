import { z } from 'zod';
import { InstantSchema } from './contracts';

/** Only production browser push providers are accepted. Never accept a caller-supplied arbitrary URL. */
export function isAllowedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || url.search || url.href.length > 4096) return false;
    const host = url.hostname;
    if (host === 'web.push.apple.com' || /^[a-z0-9-]+\.push\.apple\.com$/.test(host)) return url.pathname.length > 1;
    if (host === 'fcm.googleapis.com') return /^\/(?:fcm\/send|wp)\/[^/]+$/.test(url.pathname);
    return host === 'updates.push.services.mozilla.com' && /^\/wpush\/v[12]\/[^/]+$/.test(url.pathname);
  } catch { return false; }
}

const base64url = (bytes: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine(value => {
  // Exact unpadded base64url lengths avoid accepting megabyte-sized key material.
  return value.length === Math.ceil(bytes * 4 / 3);
});
export const PushSubscriptionInputSchema = z.strictObject({
  endpoint: z.string().max(4096).refine(isAllowedPushEndpoint, '不支持的浏览器推送地址').transform(value => new URL(value).href),
  expirationTime: z.number().int().nonnegative().nullable().optional(),
  keys: z.strictObject({ p256dh: base64url(65), auth: base64url(16) }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInputSchema>;
export const PushPreferencesSchema = z.strictObject({ showDetails: z.boolean().default(false) });
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;
export const PushSubscribeRequestSchema = z.strictObject({ subscription: PushSubscriptionInputSchema, showDetails: z.boolean().default(false) });
export const PushUnsubscribeRequestSchema = z.strictObject({ subscriptionId: z.string().regex(/^[a-f0-9]{64}$/) });

export interface PushSubscriptionSummary { id: string; deviceId: string; showDetails: boolean; active: boolean; createdAt: string; updatedAt: string }
export const PushPayloadSchema = z.strictObject({
  type: z.literal('reminder'), showDetails: z.boolean().default(false), id: z.string().min(1).max(200),
  title: z.string().max(200), body: z.string().max(2000), tag: z.string().min(1).max(100),
  // Same-origin navigation only; the service worker also validates this at display time.
  url: z.string().max(2000).refine(value => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')),
  scheduledAt: InstantSchema, expiresAt: InstantSchema,
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;
