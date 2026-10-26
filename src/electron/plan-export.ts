import { app, dialog, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildPlanContext, planContextFingerprint } from '../plan-import/context';
import { PlanExportRequestSchema, PlanSourceSchema, type PlanContext, type PlanExportDesktopAPI, type PlanExportRequest, type PlanSource } from '../shared/plan-context';
import type { Snapshot } from '../shared/contracts';
import { WorkflowError } from '../ai/deepseek';
import { readPrivate, writePrivate } from '../remote/private-file';

/** Stable profile identity, kept outside exported content; no local path becomes a shared identifier. */
export function localPlanSource(directory: string): PlanSource {
  const file = join(directory, 'plan-context-identity.json');
  const stored = readPrivate(file, 1024);
  if (stored) {
    const source = PlanSourceSchema.parse(JSON.parse(stored.toString('utf8')));
    if (source.kind !== 'local') throw new WorkflowError('STORAGE', '本机规划资料标识无效，请检查资料目录');
    return source;
  }
  const source: PlanSource = { kind: 'local', dataInstanceId: randomUUID() };
  writePrivate(file, JSON.stringify(source)); return source;
}

export function createNativePlanExport(options: {
  window(): BrowserWindow; snapshot(): Promise<Snapshot>; source(): Promise<PlanSource>;
}): PlanExportDesktopAPI {
  const pending = new Map<string, { request: PlanExportRequest; context: PlanContext; expires: number }>();
  const sameSource = (a: PlanSource, b: PlanSource) => a.kind === b.kind && a.dataInstanceId === b.dataInstanceId && (a.kind !== 'cloud' || b.kind === 'cloud' && a.generation === b.generation);
  async function current() {
    const source = PlanSourceSchema.parse(await options.source()), snapshot = await options.snapshot();
    if (!sameSource(source, PlanSourceSchema.parse(await options.source()))) throw new WorkflowError('CONFLICT', '读取时资料连接已改变，请重新预览导出');
    return { source, snapshot };
  }
  return {
    async planExportPreview(input) {
      const request = PlanExportRequestSchema.parse(input), { source, snapshot } = await current();
      let context: PlanContext;
      try { context = buildPlanContext(snapshot, request, source); }
      catch (error) { throw new WorkflowError('VALIDATION', error instanceof Error ? error.message : '无法生成目标上下文'); }
      if (Buffer.byteLength(JSON.stringify(context)) > 16 * 1024 * 1024) throw new WorkflowError('VALIDATION', '这个目标的上下文超过 16 MB，请缩短规划范围或拆分目标后导出');
      for (const [token, value] of pending) if (value.expires <= Date.now()) pending.delete(token);
      if (pending.size >= 20) pending.delete(pending.keys().next().value!);
      const token = randomUUID(); pending.set(token, { request, context, expires: Date.now() + 10 * 60000 });
      return { ok: true, data: { token, title: context.goal.title, sourceKind: source.kind, fromDate: request.fromDate, toDate: request.toDate,
        counts: { tasks: context.tasks.length, completedTasks: context.tasks.filter(task => task.status === 'done').length, blocks: context.blocks.length,
          resources: new Set(context.resourceLinks.map(link => link.resource.id)).size, busyIntervals: context.busyIntervals.length },
        warnings: ['将导出目标和关联任务的全部已有时段；规划范围用于检查课表与其他日程的占用。', '将此文件交给外部智能体生成增量计划，保留文件中的状态标记；上下文文件本身不能导入。'],
      } };
    },
    async planExportSave({ token }) {
      const selected = pending.get(token);
      if (!selected || selected.expires <= Date.now()) throw new WorkflowError('CONFLICT', '导出预览已失效，请重新预览');
      const safeName = selected.context.goal.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '目标计划';
      const target = await dialog.showSaveDialog(options.window(), { title: '保存给外部智能体的计划上下文', defaultPath: join(app.getPath('documents'), `${safeName}.calendar-context.json`), filters: [{ name: '计划上下文 JSON', extensions: ['json'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (target.canceled || !target.filePath) return { ok: true, data: { saved: false } };
      const { source, snapshot } = await current();
      if (selected.expires <= Date.now() || !sameSource(source, selected.context.basis.source)
        || planContextFingerprint(snapshot, selected.request.goalId, selected.request.fromDate, selected.request.toDate) !== selected.context.basis.fingerprint) {
        pending.delete(token); throw new WorkflowError('CONFLICT', '预览后计划或课表已变化，请重新预览导出最新内容');
      }
      await writeFile(target.filePath, JSON.stringify(selected.context, null, 2) + '\n', 'utf8');
      pending.delete(token); return { ok: true, data: { saved: true, filename: basename(target.filePath) } };
    },
  };
}
