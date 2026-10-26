import { join } from 'node:path';
import { profileFromArgs } from './files';
import { connectionArgs, remoteConfigFromArgs, type NativeRemoteConfig } from './remote-config';
import { resolveDataDirectory } from './data-directory';

declare const __PLANNER_LOCAL_ONLY__: boolean;
/** Fixed by the build, never by a user's saved connection or an environment variable. */
export const LOCAL_ONLY = typeof __PLANNER_LOCAL_ONLY__ !== 'undefined' && __PLANNER_LOCAL_ONLY__;

export function desktopEdition(localOnly: boolean) {
  return localOnly
    ? { name: '终极日历本地版', appId: 'local.ultimate-calendar.local-desktop', directoryName: '终极日历本地版', updateChannel: 'local' as const }
    : { name: '终极日历', appId: 'local.ultimate-calendar.desktop', directoryName: '终极日历', updateChannel: 'latest' as const };
}

export function desktopStartup(args: string[], documents: string, localOnly: boolean) {
  if (localOnly && args.some(arg => arg.startsWith('--planner-remote') || arg.startsWith('--planner-capture-only'))) {
    throw Error('本地版直接使用本机资料和模型 API，不接受云端连接或云端采集专用启动参数。');
  }
  // Deliberately do not read desktop-connection.json in the local edition, even if damaged.
  const startupArgs = localOnly ? args : connectionArgs(args, documents);
  const profile = profileFromArgs(startupArgs);
  const directory = profile ?? join(documents, desktopEdition(localOnly).directoryName, '数据');
  const remoteConfig: NativeRemoteConfig | null = localOnly ? null
    : remoteConfigFromArgs(startupArgs, profile, resolveDataDirectory(documents, null));
  return { profile, directory, remoteConfig };
}
