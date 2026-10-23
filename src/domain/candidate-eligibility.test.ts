import { describe, expect, it } from 'vitest';
import { CandidateSchema, type CandidateInput } from '../shared/contracts';
import { candidateDisposition, candidateExpiry, isPendingCandidate } from './candidate-eligibility';

const now = '2026-10-23T12:00:00+08:00';
const candidate = (values: Partial<CandidateInput> = {}) => CandidateSchema.parse({ id: 'candidate', title: '事项', sourceIds: ['source'], version: 1, createdAt: now, updatedAt: now, ...values });

describe('derived candidate eligibility in Shanghai time', () => {
  it('keeps a date-only deadline through its whole Shanghai date, then expires at midnight', () => {
    const c = candidate({ deadline: { date: '2026-10-23', time: null } });
    expect(isPendingCandidate(c, '2026-10-23T15:59:59.999Z')).toBe(true);
    expect(candidateExpiry(c, '2026-10-23T16:00:00Z')).toMatchObject({ expired: true, basis: 'deadline' });
  });
  it('uses a known deadline even before the later activity starts', () => {
    expect(candidateExpiry(candidate({ deadline: { date: '2026-10-23', time: '11:30' }, eventStart: '2026-10-24T10:00:00+08:00' }), now)).toMatchObject({ expired: true, basis: 'deadline' });
  });
  it('uses the explicit event end and never treats a start earlier today as an end', () => {
    expect(candidateExpiry(candidate({ eventStart: '2026-10-23T09:00:00+08:00' }), now).expired).toBe(false);
    expect(candidateExpiry(candidate({ eventStart: '2026-10-23T09:00:00+08:00', eventEnd: now }), now)).toMatchObject({ expired: true, basis: 'eventEnd' });
  });
  it('labels yesterday-only start conservatively and preserves a later deadline or multi-day possibility', () => {
    const c = candidate({ eventStart: '2026-10-22T20:00:00+08:00' });
    expect(candidateExpiry(c, now)).toMatchObject({ expired: true, basis: 'eventStartDay', reason: expect.stringContaining('原文未提供结束时间') });
    expect(candidateExpiry({ ...c, deadline: { date: '2026-10-25', time: null } }, now).expired).toBe(false);
    expect(candidateExpiry({ ...c, sourceQuote: '活动持续三天' }, now).expired).toBe(false);
    expect(candidateExpiry({ ...c, deadline: { date: '2026-10-21', time: null }, temporalEvidence: [{ field: 'deadline', basis: 'unknown', quote: '截止时间不确定' }] }, now).expired).toBe(false);
  });
  it('does not hide missing or uncertain dates, including unknown evidence and explicit review notes', () => {
    expect(candidateExpiry(candidate(), now).expired).toBe(false);
    const c = candidate({ deadline: { date: '2026-10-21', time: null }, temporalEvidence: [{ field: 'deadline', basis: 'unknown', quote: '时间待定' }] });
    expect(candidateExpiry(c, now).expired).toBe(false);
    expect(candidateExpiry(candidate({ deadline: c.deadline, uncertainties: ['截止日期年份不确定，请核对'] }), now).expired).toBe(false);
    expect(candidateExpiry(candidate({ eventStart: '2026-10-21T09:00:00+08:00', uncertainties: ['活动日期待确认'] }), now).expired).toBe(false);
    expect(candidateExpiry(candidate({ deadline: c.deadline, temporalEvidence: [{ field: 'deadline', basis: 'relative', quote: '明天' }], uncertainties: ['明天依据 sentAt 推定'] }), now).expired).toBe(true);
  });
  it('keeps accepted and ignored decisions unchanged and expires pending snoozes without writing feedback', () => {
    const c = candidate({ deadline: { date: '2026-10-21', time: null }, snoozedUntil: '2026-10-30T09:00:00+08:00' });
    const before = structuredClone(c);
    expect(candidateDisposition(c, now)).toBe('expired');
    expect(candidateDisposition({ ...c, status: 'accepted' }, now)).toBe('accepted');
    expect(candidateDisposition({ ...c, status: 'ignored' }, now)).toBe('ignored');
    expect(c).toEqual(before);
    expect(candidateDisposition(candidate({ snoozedUntil: '2026-10-24T09:00:00+08:00' }), now)).toBe('snoozed');
  });
  it('requires both a closed-item label and original closure evidence, preserving reopening and generic notices', () => {
    const c = candidate({ title: '补刷学习通视频及补交作业（已过期不开放）', sourceQuote: '过期的不会再开放' });
    expect(candidateExpiry(c, now)).toMatchObject({ expired: true, basis: 'availability' });
    expect(candidateExpiry({ ...c, title: '查看学习通作业规则' }, now).expired).toBe(false);
    expect(candidateExpiry({ ...c, sourceQuote: '已过期但仍可补交' }, now).expired).toBe(false);
    expect(candidateExpiry({ ...c, action: '已过期，但可以补交材料' }, now).expired).toBe(false);
    const reopened = { ...c, deadline: { date: '2026-10-21', time: null }, sourceQuote: '已过期但仍可补交' };
    expect(candidateExpiry(reopened, now)).toMatchObject({ expired: false, reason: expect.stringContaining('校对新的可办理时间') });
    expect(candidateExpiry({ ...reopened, sourceQuote: '报名延期至本周五' }, now).expired).toBe(false);
    expect(candidateExpiry({ ...reopened, sourceQuote: '可在本周五申请补交' }, now).expired).toBe(false);
  });
  it('expires the stated extension deadline but preserves an unverified newer deadline and does not misread denied permission', () => {
    const c = candidate({ title: '报名', deadline: { date: '2026-10-22', time: '18:00' }, sourceQuote: '报名已延期至2026年10月22日18:00，此后不再受理' });
    expect(candidateExpiry(c, now)).toMatchObject({ expired: true, basis: 'deadline' });
    expect(candidateExpiry({ ...c, sourceQuote: '报名已延期至2026年10月22日下午六点，此后不再受理' }, now).expired).toBe(true);
    expect(candidateExpiry({ ...c, deadline: { date: '2026-10-22', time: '18:45' }, sourceQuote: '报名已延期至10月22日下午六点四十五分' }, now).expired).toBe(true);
    expect(candidateExpiry({ ...c, sourceQuote: '报名已延期至2026年10月24日18:00' }, now).expired).toBe(false);
    expect(candidateExpiry({ ...c, sourceQuote: '报名已延期，新的截止时间另行通知' }, now).expired).toBe(false);
    expect(candidateExpiry({ ...c, sourceQuote: '报名已截止，不再允许补报' }, now).expired).toBe(true);
    expect(candidateExpiry({ ...c, sourceQuote: '报名已截止，仍可查询结果' }, now).expired).toBe(true);
    expect(candidateExpiry({ ...c, sourceQuote: '报名已延期至2026年10月22日18点半' }, now).expired).toBe(false);
  });
});
