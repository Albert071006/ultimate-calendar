import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { createRemoteService } from './service';
import { RemoteState } from './state';
import { createPushStore } from './push-store';
import { restoreSafeBackup } from './restore';
import { startRemoteRuntime } from './runtime';
import { readPrivate } from '../remote/private-file';
import { createExternalApiKeyConfiguration, createManagedApiKeyConfiguration } from './ai-configuration';

async function main() {
  process.umask(0o077);
  const [command = 'serve', ...args] = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || values.has(key)) throw Error('参数格式为 --名称 值，不允许重复');
    if (!['--data-dir', '--origin', '--public-origin', '--trust-loopback-proxy', '--port', '--host', '--static-dir', '--api-key-file', '--device-id', '--backup-dir', '--backup-file'].includes(key)) throw Error(`未知参数 ${key}`);
    values.set(key, value);
  }
  const directory = values.get('--data-dir');
  if (!directory || !isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root) throw Error('必须通过 --data-dir 明确指定磁盘根目录以外的绝对资料目录');
  if (command === 'status') {
    const path = join(directory, 'remote-state.sqlite'); if (!existsSync(path)) throw Error('尚无服务状态，不会为状态查询创建新资料');
    const state = new RemoteState(path, Date.now, false); try { process.stdout.write(`${JSON.stringify({ backup: state.backupStatus() }, null, 2)}\n`); } finally { state.close(); } return;
  }
  if (command === 'restore') {
    const backupFile = values.get('--backup-file'); if (!backupFile) throw Error('restore 需要 --backup-file 绝对路径');
    const restored = restoreSafeBackup({ backupFile, dataDirectory: directory });
    process.stdout.write(`已恢复到全新资料目录：${restored.dataDirectory}\n任务 ${restored.taskCount} 条，账目 ${restored.ledgerEntryCount} 条；请重新配对并配置服务端密钥\n`); return;
  }
  if (command === 'backup') {
    const service = createRemoteService({ dataDirectory: directory, backupDirectory: values.get('--backup-dir'), startupBackup: false, getApiKey: async () => null });
    try { process.stdout.write(`已导出脱敏安全备份：${service.backup()}\n`); } finally { await service.close(); }
    return;
  }
  if (command === 'advance-generation') {
    const service = createRemoteService({ dataDirectory: directory, startupBackup: false, getApiKey: async () => null });
    try { service.state.advanceGeneration(); process.stdout.write('资料代际已更新；旧待提交内容需重新核对\n'); } finally { await service.close(); }
    return;
  }
  if (command !== 'serve') {
    if (!['pair', 'revoke', 'advance-generation'].includes(command)) throw Error('命令必须为 serve、pair、revoke、advance-generation、backup、restore 或 status');
    mkdirSync(directory, { recursive: true });
    const state = new RemoteState(join(directory, 'remote-state.sqlite'), Date.now, false);
    try {
      if (command === 'pair') process.stdout.write(`一次性配对码（10分钟有效，请勿写入日志或分享）：\n${state.createPairingCode()}\n`);
      else if (command === 'revoke') {
        const id = values.get('--device-id'); if (!id) throw Error('revoke 需要 --device-id'); state.revoke(id);
        const pushStore = createPushStore(join(directory, 'notifications.sqlite')); try { pushStore.revokeDevice(id); } finally { pushStore.close(); }
        process.stdout.write('设备会话与推送已撤销\n');
      }
      else { state.advanceGeneration(); process.stdout.write('资料代际已更新；旧待提交内容需重新核对\n'); }
    } finally { state.close(); }
    return;
  }
  const origin = values.get('--origin'); if (!origin) throw Error('必须通过 --origin 指定外部 HTTPS 来源（仅本机开发可用 http）');
  const publicOrigin = values.get('--public-origin'), trustProxyValue = values.get('--trust-loopback-proxy');
  if (trustProxyValue !== undefined && !['true', 'false'].includes(trustProxyValue)) throw Error('--trust-loopback-proxy 必须为 true 或 false');
  const port = Number(values.get('--port') ?? '3210'); if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('port 必须为 1–65535');
  const keyFile = values.get('--api-key-file');
  if (keyFile && !isAbsolute(keyFile)) throw Error('--api-key-file 必须为绝对路径');
  const subject = process.env.VAPID_SUBJECT;
  // Explicit administrator configuration remains authoritative and read-only to clients.
  const apiKeyConfiguration = keyFile || process.env.DEEPSEEK_API_KEY?.trim() ? createExternalApiKeyConfiguration(async () => {
    const bytes = keyFile ? readPrivate(keyFile, 16_384) : null;
    if (keyFile && !bytes) throw Error('显式DeepSeek密钥文件不存在，未当作未配置继续启动');
    const key = keyFile ? bytes!.toString('utf8') : process.env.DEEPSEEK_API_KEY;
    if (keyFile && !key?.trim()) throw Error('显式DeepSeek密钥文件为空');
    return key?.trim() || null;
  }) : createManagedApiKeyConfiguration(join(directory, 'ai-credentials.json'));
  const runtime = await startRemoteRuntime({ origin, publicOrigin, trustLoopbackProxy: trustProxyValue === 'true', port, host: values.get('--host'), staticDirectory: values.get('--static-dir'), vapidSubject: subject,
    dataDirectory: directory, backupDirectory: values.get('--backup-dir'), apiKeyConfiguration, getApiKey: () => apiKeyConfiguration.getApiKey(),
    onBackupError: () => { process.stderr.write('BACKUP_FAILED：安全备份未完成，请检查服务磁盘与备份目录\n'); },
    onPushError: () => { process.stderr.write('PUSH_FAILED：推送任务未完成，请检查服务网络与配置\n'); } });
  process.stdout.write(`日历资料服务已启动；首次使用请单独执行 pair 命令。外部来源：${origin}\n`);
  let closing = false;
  if (!subject) process.stdout.write('手机推送未启用：需显式配置 VAPID_SUBJECT\n');
  const stop = () => { if (closing) return; closing = true; process.stdout.write('DRAINING：停止接收新请求，等待已接收操作\n'); void runtime.close().then(() => { process.stdout.write('STOPPED：服务已正常退出\n'); process.exitCode = 0; }).catch(() => { process.stderr.write('SHUTDOWN_FAILED：退出未完全正常，请核对操作回执\n'); process.exitCode = 1; }); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : '服务启动失败'}\n`); process.exitCode = 1; });
