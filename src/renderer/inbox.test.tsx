// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CandidateSchema, SnapshotSchema, SourceSchema, type CandidateInput, type Settings } from '../shared/contracts';
import { Inbox } from './components/Inbox';
import type { PlannerUI } from './hooks/usePlanner';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const now = '2026-10-23T12:00:00+08:00';
const make = (id: string, extra: Partial<CandidateInput> = {}) => CandidateSchema.parse({ id, title: id, version: 1, createdAt: now, updatedAt: now, sourceIds: ['source'], ...extra });
function view(candidates: ReturnType<typeof make>[], settings: Partial<Settings> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [SourceSchema.parse({ id: 'source', version: 1, createdAt: now, updatedAt: now, kind: 'text', text: '保留原通知', importedAt: now })], candidates, tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  const mutate = vi.fn(), edit = vi.fn(), openSource = vi.fn();
  render(<Inbox snapshot={snapshot} ui={{ busy: false, mutate } as unknown as PlannerUI} select={() => {}} edit={edit} importMessage={() => {}} openSource={openSource} />);
  return { snapshot, mutate, edit, openSource };
}

describe('candidate time-first cards and expired archive', () => {
  it('shows structured activity and deadline before actions and moves legacy time conditions without losing wording', () => {
    view([make('参加活动', { eventStart: '2026-10-24T09:00:00+08:00', eventEnd: '2026-10-24T10:30:00+08:00', deadline: { date: '2026-10-23', time: '18:00' }, conditions: ['活动时间：周六上午九点到十点半', '携带学生证'], action: '到场签到', location: '示例园' })]);
    const timing = screen.getByRole('region', { name: '事项时间' });
    expect(within(timing).getByText(/2026-10-24 09:00.*2026-10-24 10:30/)).toBeTruthy();
    expect(within(timing).getByText('2026-10-23 18:00')).toBeTruthy();
    expect(within(timing).getByText('活动时间：周六上午九点到十点半')).toBeTruthy();
    expect(screen.getByText('携带学生证')).toBeTruthy(); expect(screen.getByText('地点 · 示例园')).toBeTruthy();
    expect(timing.compareDocumentPosition(screen.getByText('需要做')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('removes expired pending cards from the inbox but preserves their sources and all accepted or ignored decisions', () => {
    const f = view([make('已截止候选', { deadline: { date: '2026-10-22', time: null } }), make('仍可判断'), make('此前已接受', { status: 'accepted', deadline: { date: '2026-10-22', time: null } }), make('此前已忽略', { status: 'ignored', deadline: { date: '2026-10-22', time: null } })]);
    expect(screen.queryByRole('heading', { name: '已截止候选' })).toBeNull(); expect(screen.getByRole('heading', { name: '仍可判断' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '已过期' }));
    expect(screen.getByRole('heading', { name: '已截止候选' })).toBeTruthy(); expect(screen.queryByRole('button', { name: '接受事项' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看来源 · 原文' })); expect(f.openSource).toHaveBeenCalledWith('source');
    expect(f.snapshot.candidates[0]?.status).toBe('pending'); expect(f.snapshot.feedback).toEqual([]); expect(f.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '已接受' })); expect(screen.getByRole('heading', { name: '此前已接受' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '已忽略' })); expect(screen.getByRole('heading', { name: '此前已忽略' })).toBeTruthy();
  });
  it('keeps ambiguous and unnormalized timing visible in pending instead of inferring a stale date', () => {
    view([make('尚需核对', { conditions: ['本周四晚上七点'], uncertainties: ['时间需校对'], temporalEvidence: [{ field: 'eventStart', basis: 'unknown', quote: '周四' }] })]);
    expect(screen.getByRole('heading', { name: '尚需核对' })).toBeTruthy();
    const timing = screen.getByRole('region', { name: '事项时间' });
    expect(within(timing).getByText('本周四晚上七点')).toBeTruthy(); expect(within(timing).getByText('时间需校对')).toBeTruthy();
  });
  it('uses campus context to suppress old speculative location questions while preserving real conflicts and source data', () => {
    const f = view([make('校园活动', { location: '示例园101', uncertainties: ['活动地点仅写示例园101，未说明校区或具体位置，需确认', '原消息地点与附件地点冲突，请核对', '具体房间可能为101或102，需确认'] })], { campus: '示例大学北校区' });
    expect(screen.getByText('地点 · 示例园101')).toBeTruthy();
    expect(screen.queryByText('活动地点仅写示例园101，未说明校区或具体位置，需确认')).toBeNull();
    expect(screen.getByText('原消息地点与附件地点冲突，请核对')).toBeTruthy();
    expect(screen.getByText('具体房间可能为101或102，需确认')).toBeTruthy();
    expect(f.snapshot.candidates[0]?.uncertainties).toHaveLength(3);
  });
});
