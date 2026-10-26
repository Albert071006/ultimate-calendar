import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { normalizeRemoteOrigin } from '../remote/node-client';
import { privatePath } from '../remote/private-file';

export const NativeRemoteConfigSchema = z.strictObject({ origin: z.string().transform(normalizeRemoteOrigin), deviceName: z.string().trim().min(1).max(80).default('Windows 日历'), pairingCodeFile: z.string().optional(), localDataDirectory: z.string().optional(), localConnectAddress: z.literal('127.0.0.1').optional() }).refine(value => !value.localConnectAddress || value.origin.startsWith('https:'), '本机连接地址仅用于保留原域名校验的 HTTPS 服务');
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
  if (config.localDataDirectory) {
    privatePath(config.localDataDirectory);
    if (canonical(config.localDataDirectory) !== b) throw Error('本机采集目录必须是这台电脑的正式资料目录');
  }
  return config;
}

/** Keep the selected data authority when an installer recreates shortcuts without arguments. */
export function connectionArgs(args: string[], documents: string): string[] {
  if (args.some(value => value.startsWith('--planner-'))) return args;
  const file = join(documents, '终极日历', 'desktop-connection.json');
  if (!existsSync(file)) return args;
  privatePath(file);
  if (!lstatSync(file).isFile() || lstatSync(file).size > 16_384) throw Error('默认电脑连接配置无效');
  const selected = z.strictObject({ profile: z.string(), configFile: z.string() }).parse(JSON.parse(readFileSync(file, 'utf8')));
  if (!isAbsolute(selected.profile) || !isAbsolute(selected.configFile)) throw Error('默认电脑连接必须使用绝对路径');
  return [...args, `--planner-profile=${selected.profile}`, `--planner-remote-config=${selected.configFile}`];
}
export type NativeRemoteConfig = z.infer<typeof NativeRemoteConfigSchema>;
