import { app } from 'electron';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readPrivate } from '../remote/private-file';
import { createWechatBridgeFactory } from '../capture/wechat-bridge';

const runtimeSchema = z.strictObject({ python: z.string().max(4000).refine(value => isAbsolute(value) && /python(?:w)?\.exe$/i.test(value)) });

/** Local administrator setup only: the renderer cannot supply programs or script paths. */
export function createLocalWechatBridge(directory: string) {
  let python = '';
  try {
    const bytes = readPrivate(join(directory, 'wechat-runtime.json'), 8192);
    if (bytes) python = runtimeSchema.parse(JSON.parse(bytes.toString('utf8'))).python;
  } catch { /* The connection page reports an unavailable runtime without breaking calendar startup. */ }
  const worker = app?.isPackaged
    ? join(process.resourcesPath, 'wechat', 'worker.py')
    : join(__dirname, '..', 'scripts', 'wechat', 'worker.py');
  return createWechatBridgeFactory({ python, worker, workdir: join(directory, 'wechat-reader-cache') });
}

export const wechatCredentials = { get: async () => null, set: async () => {}, status: () => ({ configured: false }) };
