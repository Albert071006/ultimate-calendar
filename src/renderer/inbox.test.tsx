// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CandidateSchema, SnapshotSchema, SourceSchema, type CandidateInput, type Settings } from '../shared/contracts';
import type { HostCapabilities } from '../shared/client';
import { Inbox } from './components/Inbox';
import type { PlannerUI } from './hooks/usePlanner';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const now = '2026-10-23T12:00:00+08:00';
const make = (id: string, extra: Partial<CandidateInput> = {}) => CandidateSchema.parse({ id, title: id, version: 1, createdAt: now, updatedAt: now, sourceIds: ['source'], ...extra });
function view(candidates: ReturnType<typeof make>[], settings: Partial<Settings> = {}, host?: HostCapabilities) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [SourceSchema.parse({ id: 'source', version: 1, createdAt: now, updatedAt: now, kind: 'text', text: '保留原通知', label: '合成通知群', sentAt: '2026-10-23T10:42:00+08:00', importedAt: now })], candidates, tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  const mutate = vi.fn(async (_mutations: unknown[]) => ({ status: 'applied', transactionId: 'tx-1', message: '已保存' }));
  const undo = vi.fn(async (_id?: string) => {}), edit = vi.fn(), openSource = vi.fn();
  const ui = { busy: false, mutate, undo, notice: '', error: '' } as unknown as PlannerUI;
  const result = render(<Inbox snapshot={snapshot} ui={ui} select={() => {}} edit={edit} importMessage={() => {}} openSource={openSource} host={host} />);
  return { snapshot, mutate, undo, edit, openSource, ...result };
}
const list = () => screen.getByRole('region', { name: '通知列表' });
const detail = () => screen.getByRole('article', { name: '通知详情' });
const tab = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));

describe('notice detail', () => {
  it('shows the time card with original wording, marks stated and guessed benefits and highlights time phrases', () => {
    view([make('参加活动', {
      eventStart: '2026-10-24T09:00:00+08:00', eventEnd: '2026-10-24T10:30:00+08:00', deadline: { date: '2026-10-23', time: '18:00' },
      conditions: ['活动时间：周六上午九点到十点半', '携带学生证'], action: '到场签到', location: '示例园',
      benefitKind: 'stated', benefit: '综测加分', potentialBenefit: '认识同专业同学',
      sourceQuote: '请于今天下午六点前报名，周六上午九点到十点半在示例园签到。',
      temporalEvidence: [{ field: 'deadline', basis: 'relative', quote: '今天下午六点前' }, { field: 'eventStart', basis: 'relative', quote: '周六上午九点到十点半' }],
    })]);
    expect(within(list()).getByText('合成通知群')).toBeTruthy();
    expect(within(list()).getByText('10:42')).toBeTruthy();
    const timing = within(detail()).getByRole('region', { name: '事项时间' });
    expect(within(timing).getByText('10月24日 周六 09:00–10:30')).toBeTruthy();
    expect(within(timing).getByText('10月23日 周五 18:00')).toBeTruthy();
    expect(within(timing).getByText('原文“今天下午六点前”')).toBeTruthy();
    expect(within(timing).getByText('示例园')).toBeTruthy();
    expect(within(timing).getByText('活动时间：周六上午九点到十点半')).toBeTruthy();
    expect(within(detail()).getByText('携带学生证')).toBeTruthy();
    expect(within(detail()).getByText('综测加分').querySelector('.tag')!.textContent).toBe('原文写明');
    expect(within(detail()).getByText('认识同专业同学').querySelector('.tag')!.textContent).toBe('AI 推测');
    expect([...detail().querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['今天下午六点前', '周六上午九点到十点半']);
  });

  it('keeps ambiguous and unnormalized timing visible in pending instead of inferring a stale date', () => {
    view([make('尚需核对', { conditions: ['本周四晚上七点'], uncertainties: ['时间需校对'], temporalEvidence: [{ field: 'eventStart', basis: 'unknown', quote: '周四' }] })]);
    expect(within(list()).getByRole('heading', { name: '尚需核对' })).toBeTruthy();
    expect(within(list()).getByText('时间未说明')).toBeTruthy();
    const timing = within(detail()).getByRole('region', { name: '事项时间' });
    expect(within(timing).getByText('本周四晚上七点')).toBeTruthy();
    expect(within(detail()).getByText('时间需校对')).toBeTruthy();
  });

  it('uses campus context to suppress old speculative location questions while preserving real conflicts and source data', () => {
    const f = view([make('校园活动', { location: '示例园101', uncertainties: ['活动地点仅写示例园101，未说明校区或具体位置，需确认', '原消息地点与附件地点冲突，请核对', '具体房间可能为101或102，需确认'] })], { campus: '示例大学北校区' });
    expect(within(detail()).getByText('示例园101')).toBeTruthy();
    expect(screen.queryByText('活动地点仅写示例园101，未说明校区或具体位置，需确认')).toBeNull();
    expect(screen.getByText('原消息地点与附件地点冲突，请核对')).toBeTruthy();
    expect(screen.getByText('具体房间可能为101或102，需确认')).toBeTruthy();
    expect(f.snapshot.candidates[0]?.uncertainties).toHaveLength(3);
  });
});

describe('tabs and archive', () => {
  it('counts open and postponed notices and files expired ones under processed without deciding for the user', () => {
    const f = view([
      make('已截止候选', { deadline: { date: '2026-10-22', time: null } }), make('仍可判断'),
      make('稍后再看', { snoozedUntil: '2026-10-24T09:00:00+08:00' }),
      make('此前已接受', { status: 'accepted', deadline: { date: '2026-10-22', time: null } }), make('此前已忽略', { status: 'ignored', deadline: { date: '2026-10-22', time: null } }),
    ]);
    expect(screen.getByRole('tab', { name: /^待判断 ?1$/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^稍后 ?1$/ })).toBeTruthy();
    expect(within(list()).queryByRole('heading', { name: '已截止候选' })).toBeNull();
    expect(within(list()).getByRole('heading', { name: '仍可判断' })).toBeTruthy();
    tab(/^稍后/);
    expect(within(detail()).getByText(/明天 09:00 回到待判断/)).toBeTruthy();
    tab(/^已处理/);
    expect(within(list()).getAllByRole('heading').map(h => h.textContent)).toEqual(['已截止候选', '此前已接受', '此前已忽略']);
    expect(within(list()).queryByRole('button', { name: /^接受/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '已过期' }));
    expect(within(list()).getAllByRole('heading').map(h => h.textContent)).toEqual(['已截止候选']);
    expect(screen.queryByRole('button', { name: '接受事项' })).toBeNull();
    expect(within(detail()).getByRole('button', { name: '校对时间与状态' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看来源 · 合成通知群' })); expect(f.openSource).toHaveBeenCalledWith('source');
    expect(f.snapshot.candidates[0]?.status).toBe('pending'); expect(f.snapshot.feedback).toEqual([]); expect(f.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '已接受' })); expect(within(list()).getByRole('heading', { name: '此前已接受' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '已忽略' })); expect(within(detail()).getByRole('button', { name: '恢复待判断' })).toBeTruthy();
  });
});

describe('quick decisions', () => {
  it('accepts or ignores from the row, offers undo and returns the notice to its place', async () => {
    const f = view([make('第一条'), make('第二条'), make('第三条')]);
    await act(async () => { fireEvent.click(within(list()).getByRole('button', { name: '忽略 第二条' })); });
    expect(f.mutate).toHaveBeenLastCalledWith([{ type: 'ignoreCandidate', id: '第二条', expectedVersion: 1, reason: '' }]);
    const toast = within(list()).getByRole('status');
    expect(toast.textContent).toContain('已忽略「第二条」');
    await act(async () => { fireEvent.click(within(toast).getByRole('button', { name: '撤销' })); });
    expect(f.undo).toHaveBeenCalledWith('tx-1');
    expect(list().querySelector('[aria-current="true"]')!.getAttribute('data-candidate-id')).toBe('第二条');
    await act(async () => { fireEvent.click(within(list()).getByRole('button', { name: '接受 第三条' })); });
    expect(f.mutate).toHaveBeenLastCalledWith([{ type: 'acceptCandidate', id: '第三条', expectedVersion: 1, reason: '' }]);
  });

  it('decides the selected notice from the keyboard, records the reason, and ignores keys typed into the reason', async () => {
    const f = view([make('第一条'), make('第二条', { eventStart: '2026-10-25T09:00:00+08:00' })]);
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(within(detail()).getByRole('heading', { name: '第二条' })).toBeTruthy();
    const reason = within(detail()).getByRole('textbox', { name: '决定原因（可选）' });
    fireEvent.change(reason, { target: { value: '时间冲突' } });
    fireEvent.keyDown(reason, { key: 'a' });
    expect(f.mutate).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(document.body, { key: 'i' }); });
    expect(f.mutate).toHaveBeenLastCalledWith([{ type: 'ignoreCandidate', id: '第二条', expectedVersion: 1, reason: '时间冲突' }]);
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    fireEvent.keyDown(document.body, { key: 'l' });
    const until = within(detail()).getByLabelText('再次查看时间') as HTMLInputElement;
    expect(until.value).toBe('2026-10-23T18:00');
    await act(async () => { fireEvent.click(within(detail()).getByRole('button', { name: '稍后再看' })); });
    expect(f.mutate).toHaveBeenLastCalledWith([{ type: 'snoozeCandidate', id: '第一条', expectedVersion: 1, until: '2026-10-23T18:00:00+08:00', reason: '' }]);
    await act(async () => { fireEvent.keyDown(document.body, { key: 'A' }); });
    expect(f.mutate).toHaveBeenLastCalledWith([{ type: 'acceptCandidate', id: '第一条', expectedVersion: 1, reason: '' }]);
  });
});

describe('empty inbox', () => {
  const capture = (enabled: boolean) => ({
    captureSnapshot: vi.fn(async () => ({ ok: true, data: { config: { enabled, intervalSeconds: 120 }, lastReceivedAt: '2026-10-23T11:52:00+08:00' } })),
    onCaptureChanged: () => () => {},
  }) as unknown as HostCapabilities;

  it('reports when capture last heard and when postponed notices return', async () => {
    view([make('稍后再看', { snoozedUntil: '2026-10-24T09:00:00+08:00' })], {}, capture(true));
    expect(screen.getByRole('heading', { name: '都处理完了' })).toBeTruthy();
    expect(await screen.findByText(/QQ 采集上次收到消息 11:52 · 每 2 分钟检查一次/)).toBeTruthy();
    expect(screen.getByText(/稍后决定的 1 条，最早明天 09:00 回到这里/)).toBeTruthy();
  });

  it('leaves out the capture line when capture is off or there is no host', async () => {
    view([], {}, capture(false));
    expect(screen.getByRole('heading', { name: '都处理完了' })).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByText(/QQ 采集/)).toBeNull();
    cleanup();
    view([]);
    expect(screen.queryByText(/QQ 采集/)).toBeNull();
  });
});
