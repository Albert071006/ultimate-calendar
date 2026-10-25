import { dialog, shell, type BrowserWindow } from 'electron';
import { createResourceHost } from './resources';

export function createNativeResourceHost(directory: string, window: () => BrowserWindow) {
  return createResourceHost({ directory,
    async pick(kind, multiple) {
      const result = await dialog.showOpenDialog(window(), { title: kind === 'file' ? '关联资料文件（只保存位置）' : '关联资料文件夹（只保存位置）',
        properties: [kind === 'file' ? 'openFile' : 'openDirectory', ...(multiple ? ['multiSelections' as const] : [])] });
      return result.canceled ? [] : result.filePaths;
    },
    openPath: path => shell.openPath(path),
    // Fixed Edge protocol with a validated HTTP(S) URL; no command shell or caller-controlled executable.
    openWeb: url => shell.openExternal(`microsoft-edge:${url}`),
  });
}
