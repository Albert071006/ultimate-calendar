import type { HostCapabilities } from '../shared/client';
import { ResourceReferenceSchema, ResourceUrlSchema, type ResourceReference } from '../shared/resources';

const localStart = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/)/i;
// A path with spaces must be quoted; do not guess where a file name ends and an instruction starts.
const localLocations = /["“「'](?:[A-Za-z]:[\\/]|\\\\)[^"”」'\r\n]+["”」']|(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/)[^\s"“”「」'，；。]+/gi;

export function needsResourcePreparation(text: string): boolean { return localStart.test(text) || /https?:\/\//i.test(text); }

export function redactResourcePaths(text: string): string {
  return text.replace(localLocations, '[本机资源位置]');
}

/** Register only explicitly supplied paths before the command can cross a cloud/model boundary. */
export async function prepareResourceCommand(text: string, selected: ResourceReference[], host?: HostCapabilities) {
  const references = [...selected];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"“”「」'，；。]+/gi)) {
    const url = match[0].replace(/[),;!?）！？]+$/, '');
    if (!ResourceUrlSchema.safeParse(url).success || references.some(ref => ref.kind === 'web' && ref.url === url)) continue;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
    const id = `web:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
    references.push({ id, kind: 'web', name: new URL(url).hostname, url });
  }
  const matches = [...text.matchAll(localLocations)];
  if (!matches.length) return { text, resources: references };
  if (!host?.resourceRegister) throw Error('本地文件需在所属电脑选择或关联；手机可以直接使用网页链接。');
  const paths = matches.map(match => match[0].replace(/^["“「']|["”」']$/g, ''));
  if (paths.some(path => /^file:/i.test(path))) throw Error('请使用文件选择按钮，或提供带引号的完整文件路径。');
  const registered = new Map<string, ResourceReference>();
  for (const path of new Set(paths)) {
    const result = await host.resourceRegister({ paths: [path] });
    if (!result.ok) throw Error(result.error.message);
    if (result.data.length !== 1) throw Error('未能确认文件位置，请使用文件选择按钮关联资料。');
    registered.set(path, ResourceReferenceSchema.parse(result.data[0]));
  }
  let safeText = text;
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index]!;
    const resource = registered.get(paths[index]!)!;
    const token = `已选资料「${resource.name}」（${resource.id}）`;
    safeText = safeText.slice(0, match.index) + token + safeText.slice(match.index! + match[0].length);
  }
  if (localStart.test(safeText)) throw Error('文件位置没有完整识别，请把完整路径放在引号内，或用选择文件按钮。');
  return { text: safeText, resources: [...new Map([...references, ...registered.values()].map(item => [item.id, item])).values()] };
}

export async function openCommandResources(resources: ResourceReference[], host?: HostCapabilities): Promise<string> {
  const results: string[] = [];
  for (const resource of resources) {
    if (!host?.resourceOpen) {
      results.push(resource.kind === 'web' ? `点击下方链接打开「${resource.name}」。` : `「${resource.name}」需在电脑打开。`);
      continue;
    }
    try {
      const result = await host.resourceOpen({ resource });
      results.push(result.ok ? `已交给系统打开「${resource.name}」。` : `「${resource.name}」未打开：${result.error.message}`);
    } catch { results.push(`「${resource.name}」未打开，请在资料列表重试。`); }
  }
  return results.join('\n');
}
