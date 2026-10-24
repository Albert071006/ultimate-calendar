/** OneBot mentions belong to the outer message, never to an embedded reply/forward. */
export type RecipientMessage = {
  accountId: string;
  senderId?: string | null;
  segments: readonly unknown[];
  text?: string;
};
export type RecipientAudience = 'self' | 'all' | 'others' | 'unspecified' | 'unknown';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function target(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && (value === 'all' || /^[1-9]\d*$/.test(value)) ? value : null;
}
export function mentionLabel(value: unknown, accountId: string): string {
  const recipient = target(value);
  return recipient === 'all' ? '@全体成员' : recipient === accountId ? '@我' : recipient ? '@其他成员' : '@未知成员';
}

export function recipientContext(message: RecipientMessage): {
  audience: RecipientAudience; sender: 'self' | 'other' | 'unknown'; addressedText: string | null; truncated: boolean;
} {
  let self = false, all = false, other = false, unknown = false, seen = false;
  let addressedText = '', truncated = false;
  const append = (text: string) => {
    const remaining = 6000 - addressedText.length;
    if (text.length > remaining) truncated = true;
    addressedText += text.slice(0, Math.max(0, remaining));
  };
  const mention = (value: unknown) => {
    seen = true;
    const recipient = target(value);
    if (recipient === 'all') all = true;
    else if (recipient === message.accountId) self = true;
    else if (recipient) other = true;
    else unknown = true;
    return mentionLabel(value, message.accountId);
  };
  const segments = message.segments.length ? message.segments : [{ type: 'text', data: { text: message.text ?? '' } }];
  for (const raw of segments) {
    const segment = object(raw), data = object(segment.data);
    if (segment.type === 'at') append(mention(data.qq));
    else if (segment.type === 'text' && typeof data.text === 'string') {
      // Legacy CQ strings and literal code examples were stored identically. Only
      // structured at segments prove a recipient; ambiguous text must stay eligible.
      if (/\[CQ:at,/.test(data.text)) unknown = true;
      append(data.text);
    }
    else if (segment.type === 'face') append('[表情]');
    // Deliberately do not descend into reply/forward/node contents.
  }
  const incomplete = /\[采集提示：消息超过 1000 个片段/.test(message.text ?? '');
  const audience: RecipientAudience = all ? 'all' : self ? 'self' : unknown || incomplete ? 'unknown' : other ? 'others' : 'unspecified';
  return {
    audience,
    sender: !message.senderId ? 'unknown' : message.senderId === message.accountId ? 'self' : 'other',
    addressedText: seen ? addressedText : null,
    truncated: seen && (truncated || incomplete),
  };
}
export const isAddressedElsewhere = (message: RecipientMessage): boolean => recipientContext(message).audience === 'others';
