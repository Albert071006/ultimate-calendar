import { createNodeRemoteClient } from '../remote/node-client';
import { BridgeFault, loadBridgeConfig } from './config';
import { runBridge, runBridgeOnce } from './service';

async function main() {
  const [command, option, file, ...extra] = process.argv.slice(2);
  if (!['check', 'once', 'run'].includes(command ?? '') || option !== '--config' || !file || extra.length) throw new BridgeFault('configuration');
  const config = loadBridgeConfig(file);
  if (command === 'check') { process.stdout.write(JSON.stringify({ configured: true, enabled: config.enabled }) + '\n'); return; }
  const remote = createNodeRemoteClient({ origin: config.origin, credentialsFile: config.credentialsFile, localConnectAddress: config.localConnectAddress });
  if (command === 'once') {
    try {
      const result = await runBridgeOnce(config, remote); process.stdout.write(JSON.stringify(result) + '\n');
      if ((result.issue && result.issue !== 'stopped') || result.outbox.pending || result.outbox.sending || result.outbox.blocked || result.privacyRejected || result.schemaRejected) process.exitCode = 2;
    } finally { remote.close(); }
    return;
  }
  let previous = '';
  const bridge = runBridge(config, remote, { onStatus: value => {
    const status = JSON.stringify(value); if (status !== previous) { previous = status; process.stdout.write(status + '\n'); }
  } });
  let closing = false;
  const stop = () => {
    if (closing) return; closing = true;
    void bridge.close().then(() => { remote.close(); }).catch(() => { remote.close(); process.exitCode = 1; });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
void main().catch(error => {
  process.stderr.write((error instanceof BridgeFault ? error.message : '提炼桥未能启动，请核对配置与本机权限') + '\n'); process.exitCode = 1;
});
