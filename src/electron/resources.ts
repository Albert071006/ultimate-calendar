import { statSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResourceReferenceSchema, ResourceUrlSchema, type ResourceReference } from '../shared/resources';
import { ResourcePickRequestSchema, ResourceRegisterRequestSchema, ResourceOpenRequestSchema, ResourceStatusRequestSchema, type ResourceStatus } from '../shared/resource-host';
import { newLocalResources, readLocalResources, writeLocalResources, type LocalResourceLocation } from '../storage/local-resources';
import { WorkflowError } from '../ai/deepseek';

// Opening unrecognised executable associations is outside this feature's document/resource scope.
const DOCUMENT_EXTENSIONS = new Set('.pdf .doc .docx .docm .odt .rtf .txt .md .csv .tsv .xls .xlsx .xlsm .ods .ppt .pptx .pptm .odp .epub .mobi .png .jpg .jpeg .gif .webp .bmp .tif .tiff .svg .ico .mp3 .wav .m4a .flac .ogg .mp4 .mov .mkv .avi .webm .zip .rar .7z .json .xml .yaml .yml .tex .bib'.split(' '));
export const isSupportedResourceFileName = (name: string) => DOCUMENT_EXTENSIONS.has(extname(name).toLowerCase());
export function resourceFilePath(path: string): { path: string; kind: 'file' | 'folder' } {
  if (!isAbsolute(path) || /[\u0000-\u001f]/.test(path) || /^(?:\\\\|\/\/)/.test(path) || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(path) || /:(?![\\/])/.test(path)) {
    throw new WorkflowError('VALIDATION', '请选择本机文件或文件夹的完整位置，不支持网络共享、设备路径或命令');
  }
  const target = realpathSync.native(resolve(path));
  if (/^(?:\\\\|\/\/)/.test(target)) throw new WorkflowError('VALIDATION', '关联资源只支持本机位置');
  const stat = statSync(target);
  if (stat.isDirectory()) return { path: target, kind: 'folder' };
  if (!stat.isFile() || !isSupportedResourceFileName(target)) {
    throw new WorkflowError('VALIDATION', '请选择文档、图片、音视频等资料；不支持打开程序、脚本或快捷方式');
  }
  return { path: target, kind: 'file' };
}
export interface ResourceHostOptions {
  directory: string;
  pick(kind: 'file' | 'folder', multiple: boolean): Promise<string[]>;
  openPath(path: string): Promise<string>;
  openWeb(url: string): Promise<void>;
}
export function createResourceHost(options: ResourceHostOptions) {
  const load = () => readLocalResources(options.directory);
  const metadata = (registry: NonNullable<ReturnType<typeof load>>, location: LocalResourceLocation): ResourceReference =>
    ResourceReferenceSchema.parse({ id: location.id, name: basename(location.path) || '资料文件夹', kind: location.kind, deviceId: registry.deviceId, deviceName: registry.deviceName });
  const register = (paths: string[]): ResourceReference[] => {
    // Validate the whole selection before publishing any new references.
    const selected = paths.map(resourceFilePath), registry = load() ?? newLocalResources();
    const result: ResourceReference[] = [];
    for (const item of selected) {
      const existing = registry.locations.find(location => (process.platform === 'win32' ? location.path.toLowerCase() === item.path.toLowerCase() : location.path === item.path) && location.kind === item.kind);
      const location = existing ?? { ...item, id: randomUUID(), updatedAt: new Date().toISOString() };
      if (!existing) registry.locations.push(location);
      if (!result.some(reference => reference.id === location.id)) result.push(metadata(registry, location));
    }
    writeLocalResources(options.directory, registry); return result;
  };
  const status = (resource: ResourceReference, registry = load()): ResourceStatus['status'] => {
    if (resource.kind === 'web') return 'available';
    if (!registry) return 'unregistered';
    if (registry.deviceId !== resource.deviceId) return 'other-device';
    const location = registry.locations.find(item => item.id === resource.id); if (!location) return 'unregistered';
    try { const item = resourceFilePath(location.path); return item.kind === location.kind && item.kind === resource.kind ? 'available' : 'blocked'; }
    catch (error) { return error instanceof WorkflowError ? 'blocked' : 'missing'; }
  };
  return {
    async handle(method: string, input?: unknown) {
      if (method === 'resourceRegister') return { ok: true as const, data: register(ResourceRegisterRequestSchema.parse(input).paths) };
      if (method === 'resourcePick') {
        const { kind } = ResourcePickRequestSchema.parse(input), selected = await options.pick(kind, true);
        const parsed = selected.map(resourceFilePath); if (parsed.some(item => item.kind !== kind)) throw new WorkflowError('VALIDATION', '所选资料类型不一致');
        return { ok: true as const, data: selected.length ? register(selected) : [] };
      }
      if (method === 'resourceStatus') {
        const registry = load();
        return { ok: true as const, data: ResourceStatusRequestSchema.parse(input).resources.map(resource => ({ id: resource.id, status: status(resource, registry) })) };
      }
      if (method === 'resourceRelocate') {
        const { resource } = ResourceOpenRequestSchema.parse(input); if (resource.kind === 'web') throw new WorkflowError('VALIDATION', '网页地址请在资料中编辑');
        const registry = load(); if (!registry || registry.deviceId !== resource.deviceId) throw new WorkflowError('VALIDATION', `请在 ${resource.deviceName} 重新定位这份资料`);
        const location = registry.locations.find(item => item.id === resource.id); if (!location) throw new WorkflowError('VALIDATION', '这份资料尚未在本机登记，请重新添加关联');
        const selected = await options.pick(resource.kind, false); if (!selected[0]) return { ok: true as const, data: null };
        const item = resourceFilePath(selected[0]); if (item.kind !== resource.kind) throw new WorkflowError('VALIDATION', '请保持文件或文件夹类型不变');
        Object.assign(location, item, { updatedAt: new Date().toISOString() }); writeLocalResources(options.directory, registry);
        return { ok: true as const, data: resource };
      }
      if (method === 'resourceOpen') {
        const { resource } = ResourceOpenRequestSchema.parse(input);
        if (resource.kind === 'web') {
          try { await options.openWeb(ResourceUrlSchema.parse(resource.url)); }
          catch { throw new WorkflowError('VALIDATION', '未能在 Edge 打开网页，请检查浏览器安装或手动复制网址'); }
        }
        else {
          const state = status(resource);
          if (state !== 'available') throw new WorkflowError('VALIDATION', state === 'other-device' ? `需在 ${resource.deviceName} 打开` : state === 'missing' ? '文件已移动、改名或无法访问，请重新定位；关联已保留' : state === 'blocked' ? '无法打开：该位置不是受支持的资料文件' : '本机没有这份资料的位置，请重新添加关联');
          const registry = load()!, location = registry.locations.find(item => item.id === resource.id)!;
          let opened: string;
          try { opened = await options.openPath(resourceFilePath(location.path).path); }
          catch { throw new WorkflowError('VALIDATION', '系统未能打开这份资料，请检查访问权限和默认应用；关联已保留'); }
          if (opened) throw new WorkflowError('VALIDATION', '系统未能打开这份资料，请检查访问权限和默认应用；关联已保留');
        }
        return { ok: true as const, data: { opened: true as const } };
      }
      return null;
    },
  };
}
