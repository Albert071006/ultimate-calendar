import { readFileSync } from 'node:fs';
import { isAbsolute, parse, resolve } from 'node:path';
import { z } from 'zod';
import { RemoteIdentitySchema } from '../shared/remote';

export type BridgeIssue = 'configuration' | 'source' | 'storage' | 'network' | 'auth' | 'identity' | 'validation' | 'conflict' | 'protocol' | 'stopped';
/** Messages are fixed: never propagate a SQLite path, credential, source text or HTTP response body. */
export class BridgeFault extends Error {
  constructor(readonly code: BridgeIssue) { super({ configuration: '提炼桥配置无效，请核对显式配置', source: '无法只读检查指定的采集资料', storage: '提炼发送队列无法可靠保存', network: '资料服务暂不可达，原发送标识已保留', auth: '采集设备授权需要重新核对，未继续发送', identity: '资料服务或采集设备身份发生变化，旧队列已暂停', validation: '提炼结果未通过白名单校验，未发送', conflict: '资料服务要求核对提炼编号，未更换编号重发', protocol: '资料服务回执格式无效，原发送标识已保留', stopped: '提炼桥已停止' }[code]); }
}
export function normalizeBridgeOrigin(value: string): string {
  try {
    const url = new URL(value); const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error();
    return url.origin;
  } catch { throw new BridgeFault('configuration'); }
}
const absoluteFile = z.string().min(1).refine(value => isAbsolute(value) && resolve(value) !== parse(resolve(value)).root);
export const BridgeConfigSchema = z.strictObject({
  version: z.literal(1), enabled: z.boolean().default(false),
  sourceDatabase: absoluteFile, outboxDatabase: absoluteFile, credentialsFile: absoluteFile,
  origin: z.string().transform(normalizeBridgeOrigin), identity: RemoteIdentitySchema, deviceId: z.string().uuid(),
  localConnectAddress: z.literal('127.0.0.1').optional(),
  pollSeconds: z.number().int().min(5).max(3600).default(30),
  scanBatchSize: z.number().int().min(1).max(1000).default(200), maxPagesPerTick: z.number().int().min(1).max(100).default(20),
}).refine(value => {
  const paths = [value.sourceDatabase, value.outboxDatabase, value.credentialsFile].map(path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  return new Set(paths).size === paths.length;
}, '采集资料、发送队列及授权文件必须分开');
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;
export type BridgeConfigInput = z.input<typeof BridgeConfigSchema>;
export function parseBridgeConfig(value: unknown): BridgeConfig {
  try { return BridgeConfigSchema.parse(value); } catch { throw new BridgeFault('configuration'); }
}
export function loadBridgeConfig(path: string): BridgeConfig {
  try {
    if (!isAbsolute(path)) throw Error();
    const bytes = readFileSync(path); if (bytes.length > 64 * 1024) throw Error();
    return parseBridgeConfig(JSON.parse(bytes.toString('utf8')));
  } catch { throw new BridgeFault('configuration'); }
}
