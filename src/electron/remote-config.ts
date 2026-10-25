import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { normalizeRemoteOrigin } from '../remote/node-client';
import { privatePath } from '../remote/private-file';

export const NativeRemoteConfigSchema = z.strictObject({ origin: z.string().transform(normalizeRemoteOrigin), deviceName: z.string().trim().min(1).max(80).default('Windows 日历'), pairingCodeFile: z.string().optional() });
export function remoteConfigFromArgs(args: string[], profile: string | null, formalDirectory: string) {
  const flags = args.filter(value => value.startsWith('--planner-remote-config'));
  if (!flags.length) return null;
  if (flags.length !== 1 || !flags[0]!.startsWith('--planner-remote-config=') || !profile) throw Error('云端模式需要独立 --planner-profile=绝对目录 和 --planner-remote-config=绝对JSON文件');
  const path = flags[0]!.slice('--planner-remote-config='.length);
  if (!isAbsolute(path)) throw Error('云端配置必须是绝对路径');
  privatePath(path); privatePath(profile);
  const canonical = (value: string) => existsSync(value) ? realpathSync(value) : resolve(value);
  const a = canonical(profile), b = canonical(formalDirectory);
  const contains = (parent: string, child: string) => { const r = relative(parent, child); return r === '' || r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
  if (contains(a, b) || contains(b, a) || existsSync(join(profile, 'planner.sqlite'))) throw Error('云端配置目录必须与本机正式资料及已有数据库隔离');
  if (!lstatSync(path).isFile() || lstatSync(path).size > 16_384) throw Error('云端配置文件无效');
  const config = NativeRemoteConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (config.pairingCodeFile) privatePath(config.pairingCodeFile);
  return config;
}
export type NativeRemoteConfig = z.infer<typeof NativeRemoteConfigSchema>;
