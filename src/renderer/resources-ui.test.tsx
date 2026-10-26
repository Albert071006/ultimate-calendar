// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BlockSchema, CandidateSchema, CourseSchema, GoalSchema, SnapshotSchema, TaskSchema, type Snapshot } from '../shared/contracts';
import type { HostCapabilities } from '../shared/client';
import type { ResourceReference } from '../shared/resources';
import type { PlannerUI } from './hooks/usePlanner';
import { EntityEditor } from './components/editor/EntityEditor';
import { ResourceFields, ResourceSection } from './components/resources/ResourcePanel';
import { SourceAttachments } from './components/resources/SourceAttachments';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const metadata = { version: 1, createdAt: '2026-10-25T09:00:00+08:00', updatedAt: '2026-10-25T09:00:00+08:00' };
const local: ResourceReference = { id: 'synthetic-file', kind: 'file', name: '练习答案.pdf', deviceId: 'synthetic-pc', deviceName: '学习电脑' };
const textbook: ResourceReference = { id: 'synthetic-folder', kind: 'folder', name: '课程教材', deviceId: 'synthetic-pc', deviceName: '学习电脑' };
const web: ResourceReference = { id: 'synthetic-web', kind: 'web', name: '听力练习', url: 'https://example.com/listening' };
function fixture(): Snapshot {
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  snapshot.courses.push(CourseSchema.parse({ ...metadata, id: 'course', title: '合成英语', termStart: '2026-10-19', weekday: 1, firstWeek: 1, lastWeek: 4, startTime: '08:00', endTime: '09:35', resources: [textbook] }));
  snapshot.goals.push(GoalSchema.parse({ ...metadata, id: 'goal', title: '合成目标', resources: [web] }));
  snapshot.tasks.push(TaskSchema.parse({ ...metadata, id: 'task', title: '合成练习', courseId: 'course', goalId: 'goal', resources: [local, web] }));
  snapshot.blocks.push(BlockSchema.parse({ ...metadata, id: 'block', title: '合成练习时段', taskId: 'task', start: '2026-10-26T19:00:00+08:00', end: '2026-10-26T19:30:00+08:00', kind: 'event' }));
  return snapshot;
}
function fakeUI(host?: Partial<HostCapabilities>) {
  return { host, busy: false, mutate: vi.fn(async () => ({ status: 'applied', message: '已保存' })) } as unknown as PlannerUI;
}

it('shows the original tutorial in calendar task materials and opens only after a click', async () => {
  const snapshot = fixture();
  snapshot.candidates.push(CandidateSchema.parse({ ...metadata, id: 'notice', title: '合成学习通知', status: 'accepted', taskId: 'task', sourceIds: ['notice-source'] }));
  snapshot.tasks[0]!.candidateId = 'notice';
  const sourceAttachments = vi.fn(async () => ({ ok: true as const, data: { attachments: [{ id: 'original-tutorial', name: '学习教程.docx', status: 'available' as const }], unavailableSources: 0 } }));
  const sourceAttachmentOpen = vi.fn(async () => ({ ok: true as const, data: { opened: true as const } }));
  render(<ResourceSection snapshot={snapshot} target={{ entity: 'block', id: 'block' }} ui={fakeUI({ sourceAttachments, sourceAttachmentOpen })} />);
  const open = await screen.findByRole('button', { name: '打开附件 学习教程.docx' });
  expect(sourceAttachments).toHaveBeenCalledWith({ sourceIds: ['notice-source'] });
  expect(sourceAttachmentOpen).not.toHaveBeenCalled();
  fireEvent.click(open);
  await waitFor(() => expect(sourceAttachmentOpen).toHaveBeenCalledWith({ sourceIds: ['notice-source'], attachmentId: 'original-tutorial' }));
  expect(snapshot.tasks[0]!.resources).toEqual([local, web]);
});

it('reads every source batch, deduplicates the original file and keeps a recoverable missing attachment visible', async () => {
  const sourceIds = Array.from({ length: 101 }, (_, index) => `source-${String(index).padStart(3, '0')}`);
  const sourceAttachments = vi.fn(async ({ sourceIds: batch }: { sourceIds: string[] }) => ({ ok: true as const, data: {
    attachments: [{ id: 'same-file', name: '原教程.pdf', status: 'available' as const }, ...(batch.length === 1 ? [{ id: 'missing-file', name: '补充说明.pdf', status: 'missing' as const, message: '原文件尚未下载' }] : [])], unavailableSources: 0,
  } }));
  const sourceAttachmentOpen = vi.fn(async () => ({ ok: false as const, error: { code: 'VALIDATION' as const, message: '默认应用未能打开，请重试', retryable: false } }));
  render(<SourceAttachments sourceIds={sourceIds} host={{ sourceAttachments, sourceAttachmentOpen } as unknown as HostCapabilities} />);
  const open = await screen.findByRole('button', { name: '打开附件 原教程.pdf' });
  expect(sourceAttachments.mock.calls.map(([request]) => request.sourceIds.length)).toEqual([100, 1]);
  expect(screen.getAllByRole('button', { name: '打开附件 原教程.pdf' })).toHaveLength(1);
  expect((screen.getByRole('button', { name: '打开附件 补充说明.pdf' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(open);
  await screen.findByText('默认应用未能打开，请重试');
  expect(sourceAttachmentOpen).toHaveBeenCalledWith({ sourceIds: sourceIds.slice(0, 100), attachmentId: 'same-file' });
  expect(screen.getByText('原文件尚未下载')).toBeTruthy();
});

it('opens inherited task/course material by metadata ID and shows each shared resource only once', async () => {
  const resourceOpen = vi.fn(async () => ({ ok: true as const, data: { opened: true as const } }));
  const resourceStatus = vi.fn(async ({ resources }: { resources: ResourceReference[] }) => ({ ok: true as const, data: resources.map(resource => ({ id: resource.id, status: 'available' as const })) }));
  render(<ResourceSection snapshot={fixture()} target={{ entity: 'block', id: 'block' }} ui={fakeUI({ resourceOpen, resourceStatus })} />);
  expect(screen.getByText('任务资料')).toBeTruthy();
  expect(screen.getByText('课程与目标资料')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '听力练习' })).toHaveLength(1);
  expect(screen.getByText('来自课程 · 合成英语')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '练习答案.pdf' }));
  await waitFor(() => expect(resourceOpen).toHaveBeenCalledWith({ resource: local }));
  expect(JSON.stringify(resourceOpen.mock.calls)).not.toContain('path');
});

it('shows local file limits on a hostless phone while web resources remain directly openable', () => {
  render(<ResourceSection snapshot={fixture()} target={{ entity: 'task', id: 'task' }} ui={fakeUI()} />);
  expect((screen.getByRole('button', { name: '练习答案.pdf' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByText('需在电脑打开')).toHaveLength(2);
  const link = screen.getByRole('link', { name: '听力练习' });
  expect(link.getAttribute('href')).toBe(web.kind === 'web' ? web.url : '');
  expect(link.getAttribute('rel')).toContain('noopener');
  expect(screen.queryByRole('button', { name: '文件' })).toBeNull();
});

function Fields({ host, initial = [] }: { host?: Partial<HostCapabilities>; initial?: ResourceReference[] }) {
  const [value, onChange] = useState(initial);
  return <ResourceFields value={value} onChange={onChange} host={host as HostCapabilities} />;
}

it('validates pasted web URLs, changes display names, and detaches references without native deletion', async () => {
  const open = vi.fn();
  render(<Fields host={{ resourceOpen: open }} />);
  fireEvent.click(screen.getByRole('button', { name: '网页' }));
  fireEvent.change(screen.getByLabelText('网页地址'), { target: { value: 'javascript:alert(1)' } });
  fireEvent.click(screen.getByRole('button', { name: '添加链接' }));
  expect(screen.getByRole('alert').textContent).toContain('http://');
  fireEvent.change(screen.getByLabelText('网页地址'), { target: { value: 'https://example.com/practice' } });
  fireEvent.change(screen.getByLabelText('显示名称（可选）'), { target: { value: '初稿资料' } });
  fireEvent.click(screen.getByRole('button', { name: '添加链接' }));
  fireEvent.click(screen.getByRole('button', { name: '管理资料 初稿资料' }));
  fireEvent.click(screen.getByRole('button', { name: '改名称' }));
  fireEvent.change(screen.getByLabelText('资料名称'), { target: { value: '写作答案' } });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  expect(screen.getByRole('button', { name: '写作答案' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '解除关联' }));
  expect(screen.queryByRole('button', { name: '写作答案' })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it('accepts picker and native drag references, deduplicates, and relocates a missing file without changing its resource ID', async () => {
  let status: 'missing' | 'available' = 'missing';
  const resourcePick = vi.fn(async () => ({ ok: true as const, data: [local] }));
  const resourceDrop = vi.fn(async () => ({ ok: true as const, data: [local, textbook] }));
  const resourceRelocate = vi.fn(async () => { status = 'available'; return { ok: true as const, data: local }; });
  const resourceStatus = vi.fn(async ({ resources }: { resources: ResourceReference[] }) => ({ ok: true as const, data: resources.map(resource => ({ id: resource.id, status })) }));
  render(<Fields host={{ resourcePick, resourceDrop, resourceStatus, resourceRelocate, resourceOpen: vi.fn() }} />);
  fireEvent.click(screen.getByRole('button', { name: '文件' }));
  await screen.findByRole('button', { name: '练习答案.pdf' });
  expect(resourcePick).toHaveBeenCalledWith({ kind: 'file' });
  const file = new File(['synthetic'], '练习答案.pdf');
  fireEvent.drop(screen.getByRole('group', { name: '资料' }), { dataTransfer: { files: [file] } });
  await screen.findByRole('button', { name: '课程教材' });
  expect(resourceDrop).toHaveBeenCalledWith([file]);
  expect(screen.getAllByRole('button', { name: '练习答案.pdf' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '管理资料 练习答案.pdf' }));
  fireEvent.click(screen.getByRole('button', { name: '重新定位' }));
  await waitFor(() => expect(resourceRelocate).toHaveBeenCalledWith({ resource: local }));
  await waitFor(() => expect(screen.queryAllByText('文件已移动或不存在')).toHaveLength(0));
});

it('edits inherited public material at its real owner and includes the original expected version', async () => {
  const snapshot = fixture();
  snapshot.courses.push(CourseSchema.parse({ ...snapshot.courses[0], id: 'course-thursday', weekday: 4, resources: [] }));
  snapshot.tasks[0]!.courseId = 'course-thursday';
  const ui = fakeUI();
  const view = render(<ResourceSection snapshot={snapshot} target={{ entity: 'task', id: 'task' }} ui={ui} />);
  fireEvent.click(screen.getByRole('button', { name: '管理来源 合成英语' }));
  expect(screen.getByText('公共资料，关联任务和安排会同步显示。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '管理资料 课程教材' }));
  fireEvent.click(screen.getByRole('button', { name: '解除关联' }));
  const newer = structuredClone(snapshot); newer.courses[0]!.version = 2;
  view.rerender(<ResourceSection snapshot={newer} target={{ entity: 'task', id: 'task' }} ui={ui} />);
  fireEvent.click(screen.getByRole('button', { name: '保存资料' }));
  await waitFor(() => expect(ui.mutate).toHaveBeenCalledWith([{ type: 'update', entity: 'course', id: 'course', expectedVersion: 1, scope: 'all', values: { resources: [] } }]));
});

it('keeps an existing resource association when saving ordinary task edits', async () => {
  const snapshot = fixture(), ui = fakeUI();
  render(<EntityEditor target={{ entity: 'task', id: 'task' }} snapshot={snapshot} ui={ui} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '更新练习名称' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(ui.mutate).toHaveBeenCalled());
  expect(vi.mocked(ui.mutate).mock.calls[0]![0][0]).toMatchObject({ type: 'update', entity: 'task', values: { title: '更新练习名称', resources: [local, web] } });
});

it('preserves newly synced resources when only a title is edited in an already open form', async () => {
  const snapshot = fixture(), ui = fakeUI();
  const view = render(<EntityEditor target={{ entity: 'task', id: 'task' }} snapshot={snapshot} ui={ui} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '只修改名称' } });
  const newer = structuredClone(snapshot);
  newer.tasks[0]!.resources = [local, web, textbook]; newer.tasks[0]!.version = 2;
  view.rerender(<EntityEditor target={{ entity: 'task', id: 'task' }} snapshot={newer} ui={ui} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(ui.mutate).toHaveBeenCalled());
  expect(vi.mocked(ui.mutate).mock.calls[0]![0][0]).toMatchObject({ expectedVersion: 2, values: { title: '只修改名称', resources: [local, web, textbook] } });
});

it('uses the chosen recurring-event scope when changing only the attached material', async () => {
  const snapshot = fixture(), ui = fakeUI();
  snapshot.blocks[0]!.resources = [local];
  snapshot.blocks[0]!.recurrence = { seriesId: 'synthetic-series', occurrenceStart: snapshot.blocks[0]!.start };
  render(<EntityEditor target={{ entity: 'block', id: 'block' }} snapshot={snapshot} ui={ui} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('修改 / 取消范围'), { target: { value: 'this-and-following' } });
  const material = within(screen.getByRole('group', { name: '本次资料' }));
  fireEvent.click(material.getByRole('button', { name: '管理资料 练习答案.pdf' }));
  fireEvent.click(material.getByRole('button', { name: '解除关联' }));
  fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
  await waitFor(() => expect(ui.mutate).toHaveBeenCalledWith([{ type: 'updateRecurringEvent', id: 'block', expectedVersion: 1, scope: 'this-and-following', values: { resources: [] } }]));
});
