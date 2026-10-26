import { createHash } from 'node:crypto';
import type { AnalysisUnit } from './analysis';
import type { StoredCaptureAttachment, StoredCaptureMessage } from './store';
import { recipientContext } from './recipients';

/** The uploader notice and the normal message may describe the same file with different provider fields. */
function bareFileMessage(message: StoredCaptureMessage): boolean {
  if (!message.senderId || message.changed || message.deleted || message.text.trim()) return false;
  if (recipientContext(message).audience !== 'unspecified') return false;
  return message.segments.every(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const segment = raw as Record<string, unknown>;
    if (segment.type === 'file') return true;
    const data = segment.data as Record<string, unknown> | undefined;
    return segment.type === 'text' && typeof data?.text === 'string' && !data.text.trim();
  });
}

/** Batch-local only: this never suppresses a later assignment or a different message audience. */
export function createAttachmentDeduplicator() {
  const originals = new Map<string, { sentAt: string; units: AnalysisUnit[] }[]>();
  return (attachment: StoredCaptureAttachment, message: StoredCaptureMessage, units: AnalysisUnit[], previousMessageId: string | null): AnalysisUnit[] => {
    if (attachment.kind !== 'file' || attachment.status !== 'ready' || attachment.error || !attachment.hash || !attachment.extractorVersion || !units.length || !bareFileMessage(message)) return units;
    const signature = createHash('sha256').update(JSON.stringify([
      message.accountId, message.groupId, message.senderId, attachment.name, attachment.hash, attachment.extractorVersion,
      // Equal bytes alone are insufficient when extraction changed or a quoted chunk has its own time.
      units.map(unit => [unit.locator, unit.text, unit.imageDataUrl, unit.sentAt === message.sentAt ? null : unit.sentAt]),
    ])).digest('hex');
    const candidates = originals.get(signature) ?? [];
    const original = candidates.find(item => (item.units[0]!.attachmentAliases?.at(-1)?.messageId ?? item.units[0]!.messageId) === previousMessageId
      && item.sentAt.slice(0, 16) === message.sentAt.slice(0, 16)
      && Math.abs(Date.parse(item.sentAt) - Date.parse(message.sentAt)) <= 2000
      && item.units.every(unit => (unit.attachmentAliases?.length ?? 0) < 99));
    if (!original) { candidates.push({ sentAt: message.sentAt, units }); originals.set(signature, candidates); return units; }
    for (const [index, unit] of units.entries()) {
      const { text: _text, imageDataUrl: _image, attachmentAliases: _aliases, ...alias } = unit;
      (original.units[index]!.attachmentAliases ??= []).push(alias);
    }
    return [];
  };
}

/** Reuse verified text for every original source, while keeping each message, timestamp and file link. */
export function attachmentEvidenceUnits(unit: AnalysisUnit): AnalysisUnit[] {
  return [unit, ...(unit.attachmentAliases ?? []).map(alias => ({ ...alias, text: unit.text, imageDataUrl: unit.imageDataUrl }))];
}
