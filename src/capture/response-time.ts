import { isRealDate, InstantSchema, TIMEZONE } from '../shared/contracts';
import { evidenceTimes, fieldEvidenceDate } from '../domain/temporal-evidence';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function explicitLocalTime(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return value;
  const normalized = `${value.length === 16 ? `${value}:00` : value}+08:00`;
  // The shared boundary checks real dates, clock ranges and leap years. Do not
  // use Date parsing, which can silently roll an invalid date into next month.
  return InstantSchema.safeParse(normalized).success ? normalized : value;
}

/** Narrow adapter for new/pending capture JSON, before the existing strict
 * request schema. The caller must supply its trusted prompt timezone; never
 * derive that context from model output. Paid completed checkpoints bypass it.
 * Input objects are never mutated; missing fields and explicit offsets stay
 * untouched. */
type TimeSource = { id: string; text: string; sentAt: string | null };

function eventTime(candidate: Record<string, unknown>, field: 'eventStart' | 'eventEnd', sources: TimeSource[]): unknown {
  const value = candidate[field];
  if (typeof value !== 'string' || !isRealDate(value)) return explicitLocalTime(value);
  if (!Array.isArray(candidate.sourceIds) || candidate.sourceIds.length !== 1 || !Array.isArray(candidate.temporalEvidence)) return value;
  const primaryId = candidate.sourceIds[0], source = sources.find(item => item.id === primaryId);
  if (!source) return value;
  // A calendar instant needs a clock. Preserve the verified day in the evidence, including words like “左右”.
  const quotes = candidate.temporalEvidence.filter(e => object(e) && e.field === field);
  const verified = quotes.length > 0 && quotes.every(e => typeof e.quote === 'string' && e.quote.length > 0
    && source.text.includes(e.quote) && fieldEvidenceDate(e.quote, source.sentAt, field) === value && !evidenceTimes(e.quote).length);
  return verified ? null : value;
}

export function normalizeCaptureResponseTimes(value: unknown, timezone: string, sources: TimeSource[] = []): unknown {
  if (timezone !== TIMEZONE || !object(value) || !Array.isArray(value.candidates)) return value;
  let changed = false;
  const candidates = value.candidates.map(candidate => {
    if (!object(candidate)) return candidate;
    const start = eventTime(candidate, 'eventStart', sources), end = eventTime(candidate, 'eventEnd', sources);
    if (start === candidate.eventStart && end === candidate.eventEnd) return candidate;
    changed = true;
    return { ...candidate,
      ...(start !== candidate.eventStart ? { eventStart: start } : {}),
      ...(end !== candidate.eventEnd ? { eventEnd: end } : {}),
    };
  });
  return changed ? { ...value, candidates } : value;
}
