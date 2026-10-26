import { app, dialog, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedFile } from './files';
import { WorkflowError } from '../ai/deepseek';
import { createPlanImportService } from '../plan-import/service';
import { MAX_PLAN_FILE_BYTES, PLAN_FILE_EXAMPLE, PlanFileSchema, type PlanImportDesktopAPI } from '../shared/plan-import';
import { readLocalResources } from '../storage/local-resources';

export function createNativePlanImport(options: Parameters<typeof createPlanImportService>[0] & {
  resourceDirectory: string; window(): BrowserWindow; changed(): void;
}): PlanImportDesktopAPI {
  const service = createPlanImportService(options);
  return {
    async planImportOpen() {
      const selection = await dialog.showOpenDialog(options.window(), { title: '选择计划 JSON 文件', properties: ['openFile'], filters: [{ name: '终极日历计划 JSON', extensions: ['json'] }] });
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, data: null };
      let value: unknown;
      try {
        const bytes = await boundedFile(selection.filePaths[0], MAX_PLAN_FILE_BYTES);
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
      } catch { throw new WorkflowError('VALIDATION', '计划文件需为不超过 1 MB 的 UTF-8 JSON；请检查文件编码、括号和逗号。'); }
      const parsed = PlanFileSchema.safeParse(value);
      if (!parsed.success) throw new WorkflowError('VALIDATION', parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join('.') || '文件'}：${issue.message}`).join('；'));
      // File references must be actual existing metadata. Reading a plan never registers or opens arbitrary paths.
      const local = parsed.data.resources.filter(resource => resource.kind !== 'web');
      if (local.length) {
        const registry = readLocalResources(options.resourceDirectory);
        for (const resource of local) if (!registry || resource.deviceId !== registry.deviceId || !registry.locations.some(location => location.id === resource.id && location.kind === resource.kind))
          throw new WorkflowError('VALIDATION', `资料“${resource.name}”尚未在这台电脑登记。请先在日历中关联该文件，再使用真实资料引用；也可以改用网页链接。`);
      }
      try { return { ok: true, data: await service.preview(parsed.data) }; }
      catch (error) { throw new WorkflowError('VALIDATION', error instanceof Error ? error.message : '计划预览未完成，请重新选择原文件'); }
    },
    async planImportConfirm(request) {
      try { return { ok: true, data: await service.confirm(request) }; }
      catch (error) { throw new WorkflowError('CONFLICT', error instanceof Error ? error.message : '导入未完成，请重新选择原文件继续核对'); }
      finally { options.changed(); }
    },
    async planImportTemplate() {
      const selection = await dialog.showSaveDialog(options.window(), { title: '保存计划 JSON 示例', defaultPath: join(app.getPath('documents'), '学习计划示例.calendar-plan.json'), filters: [{ name: '计划 JSON', extensions: ['json'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (selection.canceled || !selection.filePath) return { ok: true, data: { saved: false } };
      await writeFile(selection.filePath, JSON.stringify({ ...PLAN_FILE_EXAMPLE, planId: `plan-${randomUUID()}` }, null, 2) + '\n', 'utf8');
      return { ok: true, data: { saved: true } };
    },
  };
}
