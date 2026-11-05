import { z } from 'zod';
import type { ChatMessage } from '../ai/deepseek';
import { WorkflowError } from '../ai/deepseek';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';

/** Details are references into this request only, never arbitrary disk/database lookups. */
export const CaptureDetailRequestSchema = z.strictObject({ needsDetails: z.strictObject({
  context: z.array(z.string()).max(60), candidates: z.array(z.string()).max(30),
}) });
export type CaptureDetails = z.infer<typeof CaptureDetailRequestSchema>['needsDetails'];
export type CaptureDetailEvidence = { context?: Map<string, { text: string }>; candidates?: Map<string, { text: string; sentAt: string | null }[]> };

const wireInstructions = `capture-wire-v1：u=当前来源，m=上下文消息，c=已有候选，r=未列入候选的原事项。短码只在本次有效，r不能作为来源或关联目标。表格columns/rows按列名解读；unit.label对应labels下标；省略字段为空值。sameTextAs只复用文字，本条日期和recipient独立；originalEvidence只读，不可作为当前来源。若必须补读原文，可例外输出 {"needsDetails":{"context":["m1"],"candidates":["c1"]}}，不同时输出candidates。detailsExpanded=true后不能再请求；仍不明确须保留有依据的待判断事项并说明uncertainties，不得猜测或声称已读完不完整的附件。`;

/** Decode the compact table shape for both the model contract and isolated regression fixtures. */
export function expandCaptureTable(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return array(value);
  const table = object(value);
  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) return [];
  const columns = table.columns.filter((key): key is string => typeof key === 'string');
  return table.rows.map(row => Object.fromEntries(columns.map((key, index) => [key, Array.isArray(row) ? row[index] : null])));
}
function table(values: JsonObject[]) {
  const columns = [...new Set(values.flatMap(value => Object.keys(value)))];
  return { columns, rows: values.map(value => columns.map(key => value[key] ?? null)) };
}

/** The original semantic messages/checkpoints remain unchanged. Only the paid wire input is packed. */
export function compactCaptureMessages(messages: ChatMessage[], details?: CaptureDetails, evidence?: CaptureDetailEvidence) {
  const user = messages.find(message => message.role === 'user');
  if (!user || typeof user.content === 'string' || user.content[0]?.type !== 'text') throw Error('Capture input is missing evidence');
  const input = object(JSON.parse(user.content[0].text));
  const units = array(input.units), context = array(input.context), candidates = array(input.existingCandidates);
  const sourceIds = new Map(units.map((unit, index) => [string(unit.id), `u${index + 1}`]));
  const messageIds = new Map<string, string>();
  for (const value of [...units.map(unit => string(unit.messageId)), ...context.map(value => string(value.id))]) if (value && !messageIds.has(value)) messageIds.set(value, `m${messageIds.size + 1}`);
  const candidateIds = new Map(candidates.map((candidate, index) => [string(candidate.id), `c${index + 1}`]));
  const inverse = (map: Map<string, string>) => new Map([...map].map(([key, value]) => [value, key]));
  const sourceByAlias = inverse(sourceIds), messageByAlias = inverse(messageIds), candidateByAlias = inverse(candidateIds);
  const requiredContexts = new Set((details?.context ?? []).map(id => messageIds.get(id) ?? id)), requiredCandidates = new Set((details?.candidates ?? []).map(id => candidateIds.get(id) ?? id));
  for (const id of requiredContexts) if (!messageByAlias.has(id)) throw new WorkflowError('AI_RESPONSE', '补读请求引用了未知上下文');
  for (const id of requiredCandidates) if (!candidateByAlias.has(id)) throw new WorkflowError('AI_RESPONSE', '补读请求引用了未知事项');
  const recipient = (raw: unknown, text: string) => {
    const value = object(raw);
    return { audience: value.audience ?? 'unknown', sender: value.sender ?? 'unknown',
      ...(value.addressedText && value.addressedText !== text ? { addressedText: value.addressedText } : {}),
      ...(value.truncated || value.addressedTextTruncated ? { truncated: true } : {}) };
  };
  const labels = [...new Set(units.map(unit => string(unit.label)))];
  const attachmentIds = new Map<string, string>();
  for (const unit of units) if (unit.attachmentId && !attachmentIds.has(string(unit.attachmentId))) attachmentIds.set(string(unit.attachmentId), `a${attachmentIds.size + 1}`);
  // Keep the full new evidence, including original dates and per-message audience.
  const packedUnits = units.map(unit => ({ id: sourceIds.get(string(unit.id)), messageId: messageIds.get(string(unit.messageId)),
    sentAt: unit.sentAt, text: unit.text, locator: unit.locator, label: labels.indexOf(string(unit.label)),
    ...(unit.hasImage ? { hasImage: true } : {}), attachmentId: attachmentIds.get(string(unit.attachmentId)) ?? null,
    recipient: recipient(unit.recipient, string(unit.text)),
  }));
  const evidenceText = new Map(units.map(unit => [string(unit.text), sourceIds.get(string(unit.id))!]));
  // Do not send the same body again as context; keep extra attachment/background evidence.
  const packedContext = [...new Map(context.map(value => [string(value.id), value])).values()].flatMap(value => {
    const id = messageIds.get(string(value.id))!, text = evidence?.context?.get(string(value.id))?.text ?? string(value.text), sameTextAs = evidenceText.get(text);
    if (sameTextAs && !value.attachments && units.some(unit => unit.messageId === value.id && unit.text === text && unit.sentAt === value.sentAt
      && JSON.stringify(recipient(unit.recipient, text)) === JSON.stringify(recipient(value.recipient, text)))) return [];
    // Preserve the whole semantic context. Lossless packing already saves enough
    // tokens; don't make a negative relevance decision depend on a clipped preview.
    return [{ id, sentAt: value.sentAt,
      ...(sameTextAs ? { sameTextAs } : { text }),
      recipient: recipient(value.recipient, text), ...(value.attachments ? { attachments: value.attachments } : {}) }];
  });
  const outsideRevisions = new Map<string, string>();
  const packedCandidates = candidates.map(candidate => {
    const id = candidateIds.get(string(candidate.id))!;
    const revisionId = string(candidate.revisionOfId);
    if (revisionId && !candidateIds.has(revisionId) && !outsideRevisions.has(revisionId)) outsideRevisions.set(revisionId, `r${outsideRevisions.size + 1}`);
    const base = { id, title: candidate.title, action: candidate.action, status: candidate.status,
      deadline: candidate.deadline, eventStart: candidate.eventStart, eventEnd: candidate.eventEnd,
      resolvedDates: candidate.resolvedDates, sourceSentAt: candidate.sourceSentAt, location: candidate.location,
      ...(candidate.revisionOfId ? { revisionOfId: candidateIds.get(revisionId) ?? outsideRevisions.get(revisionId) } : {}) };
    // Keep conditions and benefits: moving them to another model round can cost
    // more than it saves, and can distort duplicate or eligibility decisions.
    const extra = ['benefit', 'benefitKind', 'potentialBenefit', 'conditions'].filter(key => candidate[key] && candidate[key] !== 'unknown' && (!Array.isArray(candidate[key]) || candidate[key].length));
    return { ...base, ...Object.fromEntries(extra.map(key => [key, candidate[key]])),
      ...(evidence?.candidates?.has(string(candidate.id)) ? { originalEvidence: evidence.candidates.get(string(candidate.id)) } : {}) };
  });
  const packed = { format: 'capture-wire-v1', userProfile: input.userProfile, warnings: input.warnings,
    labels, units: packedUnits, context: packedContext, existingCandidates: table(packedCandidates),
    ...(details ? { detailsExpanded: true } : {}) };
  const parts: Exclude<ChatMessage['content'], string> = [{ type: 'text', text: JSON.stringify(packed) }];
  for (let index = 1; index < user.content.length; index++) {
    const part = user.content[index]!;
    if (part.type === 'image_url') parts.push(part);
    else {
      let text = part.text;
      for (const [id, alias] of sourceIds) text = text.replaceAll(id, alias);
      parts.push({ type: 'text', text });
    }
  }
  const packedMessages = messages.map(message => message === user ? { ...message, content: parts }
    : message.role === 'system' ? { ...message, content: `${message.content}\n${wireInstructions}`
      .replace('当前允许来源只取 allowedSourceIds', '当前允许来源只取 units 中的 id')
      .replace('existingCandidates 中 qq-stage: 开头的 ID 是本批已完成片段的稳定候选标识', 'existingCandidates 包含本批已完成片段的候选标识') } : message);
  const resolve = (value: unknown, aliases: Map<string, string>, originals: Map<string, string>) => {
    if (typeof value !== 'string') return value;
    // Legacy source IDs may still be echoed by compatible providers. They must be
    // in this exact request's whitelist; unknown IDs survive to strict validation.
    return aliases.get(value) ?? (originals.has(value) ? value : `invalid-wire-id:${value}`);
  };
  function decode(value: unknown): unknown {
    const detail = CaptureDetailRequestSchema.safeParse(value);
    if (detail.success) {
      // Persist even an invalid model request before validating it, so retries do
      // not charge again for the same failed response.
      return { needsDetails: { context: detail.data.needsDetails.context.map(id => messageByAlias.get(id) ?? `invalid-wire-id:${id}`),
        candidates: detail.data.needsDetails.candidates.map(id => candidateByAlias.get(id) ?? `invalid-wire-id:${id}`) } };
    }
    const root = object(value);
    if (!Array.isArray(root.candidates)) return value;
    return { ...root, candidates: root.candidates.map(raw => {
      const candidate = object(raw), relation = object(candidate.relation);
      return { ...candidate,
        ...(Array.isArray(candidate.sourceIds) ? { sourceIds: candidate.sourceIds.map(id => resolve(id, sourceByAlias, sourceIds)) } : {}),
        ...(Array.isArray(candidate.supportingSources) ? { supportingSources: candidate.supportingSources.map(raw => { const ref = object(raw); return { ...ref, sourceId: resolve(ref.sourceId, sourceByAlias, sourceIds) }; }) } : {}),
        ...(candidate.relation ? { relation: { ...relation, ...(relation.candidateId ? { candidateId: resolve(relation.candidateId, candidateByAlias, candidateIds) } : {}) } } : {}),
      };
    }) };
  }
  return { messages: packedMessages, decode, candidateIds: candidates.map(candidate => string(candidate.id)) };
}
