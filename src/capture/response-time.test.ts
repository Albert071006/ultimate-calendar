import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CaptureExtractionSchema, captureRequestSchema } from './candidate-batch';
import { normalizeCaptureResponseTimes } from './response-time';

const timezone = 'Asia/Shanghai';
const candidate = () => ({ title: '参加合成讲座', action: '参加合成讲座', benefit: '', benefitKind: 'unknown', potentialBenefit: '',
  conditions: [], uncertainties: [], sourceIds: ['synthetic-source'], sourceQuote: '2032年4月17日14:30至15:45在示例教室参加讲座',
  deadline: null, eventStart: '2032-04-17T14:30', eventEnd: '2032-04-17T15:45:30', location: '示例教室',
  temporalEvidence: [{ field: 'eventStart', basis: 'explicit', quote: '2032年4月17日14:30' }, { field: 'eventEnd', basis: 'explicit', quote: '至15:45' }],
  relation: { kind: 'new', candidateId: null } });
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('capture response local time adapter', () => {
  it('fixes only the missing seconds and offset that otherwise fail the live request schema', () => {
    const raw = { candidates: [candidate()] }, schema = captureRequestSchema(['synthetic-source']);
    const rejected = schema.safeParse(raw);
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues.map(issue => ({ code: issue.code, path: issue.path }))).toEqual([
      { code: 'custom', path: ['candidates', 0, 'eventStart'] }, { code: 'custom', path: ['candidates', 0, 'eventEnd'] },
    ]);
    const normalized = normalizeCaptureResponseTimes(raw, timezone);
    expect(schema.parse(normalized)).toEqual({ candidates: [{ ...raw.candidates[0], eventStart: '2032-04-17T14:30:00+08:00', eventEnd: '2032-04-17T15:45:30+08:00' }] });
  });

  it.each(['UTC', 'Asia/Tokyo', 'asia/shanghai', '+08:00', ''])('requires the explicit trusted Shanghai context, not %s', zone => {
    const raw = { candidates: [candidate()], timezone };
    expect(normalizeCaptureResponseTimes(raw, zone)).toBe(raw);
  });

  it.each([
    '2031-02-29T14:30', '2032-02-30T14:30', '2032-04-31T14:30', '0000-01-01T14:30',
    '2032-00-17T14:30', '2032-13-17T14:30', '2032-04-00T14:30',
    '2032-04-17T24:00', '2032-04-17T14:60', '2032-04-17T14:30:60',
    '2032-4-17T14:30', '2032-04-17T4:30', '2032-04-17 14:30', '2032-04-17T14:30:00.123',
    '2032-04-17T14:30 ', ' 2032-04-17T14:30', '2032-04-17', '明天下午', '14:30',
  ])('does not repair an invalid, ambiguous or unsupported time %s', time => {
    const raw = { candidates: [{ ...candidate(), eventStart: time, eventEnd: time }] };
    expect(normalizeCaptureResponseTimes(raw, timezone)).toBe(raw);
    expect(captureRequestSchema(['synthetic-source']).safeParse(raw).success).toBe(false);
  });

  it('accepts a real leap date and does not infer an absent end time or a deadline', () => {
    const raw = { candidates: [{ ...candidate(), eventStart: '2032-02-29T00:00', eventEnd: null, deadline: { date: '2032-02-29', time: '15:00' } }] };
    expect(normalizeCaptureResponseTimes(raw, timezone)).toEqual({ candidates: [{ ...raw.candidates[0], eventStart: '2032-02-29T00:00:00+08:00' }] });
    const missing = { candidates: [{ eventStart: '2032-02-29T23:59:59' }] };
    expect(normalizeCaptureResponseTimes(missing, timezone)).toEqual({ candidates: [{ eventStart: '2032-02-29T23:59:59+08:00' }] });
  });

  it.each(['2032-04-17T14:30:00+08:00', '2032-04-17T14:30:00.123+08:00', '2032-04-17T06:30:00Z', '2032-04-17T14:30:00+09:00'])('leaves explicit offsets untouched: %s', time => {
    const raw = { candidates: [{ ...candidate(), eventStart: time, eventEnd: null }] };
    expect(normalizeCaptureResponseTimes(raw, timezone)).toBe(raw);
  });

  it('leaves the original pending JSON and fingerprint untouched while returning a separate normalized value', () => {
    const rawCandidate = Object.freeze(candidate());
    const untouched = Object.freeze({ ...candidate(), eventStart: null, eventEnd: null });
    const raw = Object.freeze({ candidates: Object.freeze([rawCandidate, untouched]) });
    const before = fingerprint(raw);
    const normalized = normalizeCaptureResponseTimes(raw, timezone) as { candidates: unknown[] };
    expect(normalized).not.toBe(raw);
    expect(normalized.candidates[0]).not.toBe(rawCandidate);
    expect(normalized.candidates[1]).toBe(untouched);
    expect(rawCandidate.eventStart).toBe('2032-04-17T14:30');
    expect(fingerprint(raw)).toBe(before);
    expect(normalizeCaptureResponseTimes(normalized, timezone)).toBe(normalized);
  });

  it('does not traverse completed checkpoints or change a valid legacy response hash and optional fields', () => {
    const legacy = { candidates: [{ ...candidate(), eventStart: '2032-04-17T14:30:00+08:00', eventEnd: null }] };
    const parsed = CaptureExtractionSchema.parse(legacy);
    expect(normalizeCaptureResponseTimes(parsed, timezone)).toBe(parsed);
    expect(fingerprint(parsed)).toBe(fingerprint(legacy));
    expect(parsed.candidates[0]).not.toHaveProperty('supportingSources');
    expect(parsed.candidates[0]).not.toHaveProperty('eventKey');
    const checkpoint = { completed: [{ key: 'synthetic-paid-fragment', value: { candidates: [candidate()] } }] };
    expect(normalizeCaptureResponseTimes(checkpoint, timezone)).toBe(checkpoint);
  });

  it('keeps strict rejection of wrong sources and unknown fields after time normalization', () => {
    const raw = { candidates: [{ ...candidate(), sourceIds: ['wrong-fragment'], extraField: 'synthetic' }] };
    const parsed = captureRequestSchema(['synthetic-source']).safeParse(normalizeCaptureResponseTimes(raw, timezone));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.path.join('.') === 'candidates.0.sourceIds.0')).toBe(true);
      expect(parsed.error.issues.some(issue => issue.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it.each([null, [], 'synthetic', { candidates: null }, { candidates: [null, [], 'synthetic', 3, { eventStart: 3, eventEnd: false }] }])('leaves malformed structures unchanged for the existing validator', raw => {
    expect(normalizeCaptureResponseTimes(raw, timezone)).toBe(raw);
  });
});
