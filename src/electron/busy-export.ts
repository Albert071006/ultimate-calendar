import { app, dialog, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { WorkflowError } from '../ai/deepseek';
import { buildBusyContext, busyContextFingerprint } from '../plan-import/busy-context';
import { BusyExportRequestSchema, type BusyContext, type BusyExportDesktopAPI, type BusyExportRequest } from '../shared/busy-context';
import type { Snapshot } from '../shared/contracts';
import { PlanSourceSchema, type PlanSource } from '../shared/plan-context';

export function createNativeBusyExport(options: {
  window(): BrowserWindow; snapshot(): Promise<Snapshot>; source(): Promise<PlanSource>;
}): BusyExportDesktopAPI {
  const pending = new Map<string, { request: BusyExportRequest; context: BusyContext; fingerprint: string; expires: number }>();
  const sameSource = (a: PlanSource, b: PlanSource) => a.kind === b.kind && a.dataInstanceId === b.dataInstanceId && (a.kind !== 'cloud' || b.kind === 'cloud' && a.generation === b.generation);
  async function current() {
    const source = PlanSourceSchema.parse(await options.source()), snapshot = await options.snapshot();
    if (!sameSource(source, PlanSourceSchema.parse(await options.source()))) throw new WorkflowError('CONFLICT', '读取时资料连接已改变，请重新预览忙碌时间');
    return { source, snapshot };
  }
  return {
    async busyExportPreview(input) {
      const request = BusyExportRequestSchema.parse(input), { source, snapshot } = await current();
      let context: BusyContext;
      try { context = buildBusyContext(snapshot, request, source); }
      catch (error) { throw new WorkflowError('VALIDATION', error instanceof Error ? error.message : '无法生成忙碌时间文件'); }
      // Measure the actual pretty-printed UTF-8 payload that will be saved.
      if (Buffer.byteLength(JSON.stringify(context, null, 2) + '\n') > 16 * 1024 * 1024) throw new WorkflowError('VALIDATION', '忙碌时间文件超过 16 MB，请缩短日期范围后导出');
      for (const [token, value] of pending) if (value.expires <= Date.now()) pending.delete(token);
      if (pending.size >= 20) pending.delete(pending.keys().next().value!);
      const token = randomUUID(); pending.set(token, { request, context, fingerprint: busyContextFingerprint(snapshot, request), expires: Date.now() + 10 * 60_000 });
      return { ok: true, data: { token, sourceKind: source.kind, fromDate: request.fromDate, toDate: request.toDate,
        counts: { intervals: context.busyIntervals.length, courses: context.busyIntervals.filter(value => value.category === 'course').length, work: context.busyIntervals.filter(value => value.category === 'work').length, events: context.busyIntervals.filter(value => value.category === 'event').length },
        warnings: [request.includeBusyTitles ? '文件包含此范围内的忙碌事项标题。' : '文件不包含忙碌事项标题。', '只导出所选日期内已确认的占用；不导出目标、任务正文、资源和来源原文。', '将文件交给外部智能体生成新目标计划；文件本身不能导入，生成的计划仍须预览最新冲突。'],
      } };
    },
    async busyExportSave({ token }) {
      const selected = pending.get(token);
      if (!selected || selected.expires <= Date.now()) throw new WorkflowError('CONFLICT', '忙碌时间预览已失效，请重新预览');
      const target = await dialog.showSaveDialog(options.window(), { title: '保存给外部智能体的忙碌时间', defaultPath: join(app.getPath('documents'), `忙碌时间-${selected.request.fromDate}-${selected.request.toDate}.calendar-busy.json`), filters: [{ name: '忙碌时间 JSON', extensions: ['json'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (target.canceled || !target.filePath) return { ok: true, data: { saved: false } };
      const { source, snapshot } = await current();
      if (selected.expires <= Date.now() || !sameSource(source, selected.context.source) || busyContextFingerprint(snapshot, selected.request) !== selected.fingerprint) {
        pending.delete(token); throw new WorkflowError('CONFLICT', '预览后课表或忙碌安排已变化，请重新预览导出最新内容');
      }
      await writeFile(target.filePath, JSON.stringify(selected.context, null, 2) + '\n', 'utf8');
      pending.delete(token); return { ok: true, data: { saved: true, filename: basename(target.filePath) } };
    },
  };
}
