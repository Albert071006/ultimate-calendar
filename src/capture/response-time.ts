import { InstantSchema, TIMEZONE } from '../shared/contracts';

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
export function normalizeCaptureResponseTimes(value: unknown, timezone: string): unknown {
  if (timezone !== TIMEZONE || !object(value) || !Array.isArray(value.candidates)) return value;
  let changed = false;
  const candidates = value.candidates.map(candidate => {
    if (!object(candidate)) return candidate;
    const start = explicitLocalTime(candidate.eventStart), end = explicitLocalTime(candidate.eventEnd);
    if (start === candidate.eventStart && end === candidate.eventEnd) return candidate;
    changed = true;
    return { ...candidate,
      ...(start !== candidate.eventStart ? { eventStart: start } : {}),
      ...(end !== candidate.eventEnd ? { eventEnd: end } : {}),
    };
  });
  return changed ? { ...value, candidates } : value;
}
