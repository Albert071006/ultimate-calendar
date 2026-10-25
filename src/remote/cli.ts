import { parseArgs } from 'node:util';
import { createNodeRemoteClient } from './node-client';
import { readPrivate } from './private-file';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { origin: { type: 'string' }, credentials: { type: 'string' }, 'code-file': { type: 'string' }, name: { type: 'string' } } });
  if (!['pair', 'status'].includes(positionals[0] ?? '') || positionals.length !== 1 || !values.origin || !values.credentials) throw Error('用法：remote.mjs pair|status --origin HTTPS根地址 --credentials 绝对凭据文件 [--code-file 绝对配对码文件 --name 设备名]');
  const client = createNodeRemoteClient({ origin: values.origin, credentialsFile: values.credentials });
  try {
    if (positionals[0] === 'pair') {
      if (!values['code-file'] || !values.name) throw Error('配对需要 --code-file 和 --name，配对码不会进入命令参数或输出');
      const bytes = readPrivate(values['code-file'], 256); if (!bytes) throw Error('配对码文件不存在');
      console.log(JSON.stringify(await client.pair(bytes.toString('utf8').trim(), values.name), null, 2));
    } else console.log(JSON.stringify({ session: await client.getSession(), service: await client.status() }, null, 2));
  } finally { client.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : '远程客户端未完成'); process.exitCode = 1; });
