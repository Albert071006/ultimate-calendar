import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Manual/probe-runner helper. No daemon, schedule, cookies or API credentials.
const args = process.argv.slice(2), values = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--url', '--host'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw Error('Use --url <health URL> [--host <canonical Host>]');
  values.set(args[i], args[i + 1]);
}
const url = new URL(values.get('--url') ?? 'http://127.0.0.1:3210/readyz');
if (!['http:', 'https:'].includes(url.protocol) || !['/healthz', '/readyz'].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw Error('Only healthz/readyz probe URLs are accepted');
const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers: values.has('--host') ? { Host: values.get('--host') } : {} }, response => {
  let text = '', bytes = 0;
  response.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) { request.destroy(); process.stderr.write('PROBE_INVALID_RESPONSE\n'); process.exitCode = 1; } else text += chunk.toString(); });
  response.on('end', () => {
    try {
      const value = JSON.parse(text);
      if (response.statusCode !== 200 || (url.pathname === '/readyz' ? value.ready !== true : value.status !== 'ok')) throw Error();
      if (value.checks?.backup === 'failed') { process.stdout.write('READY_DEGRADED_BACKUP\n'); process.exitCode = 2; }
      else { process.stdout.write('HEALTHY\n'); process.exitCode = 0; }
    } catch { process.stderr.write('NOT_READY\n'); process.exitCode = 1; }
  });
});
request.setTimeout(5000, () => request.destroy(Error('probe deadline')));
request.on('error', () => { process.stderr.write('PROBE_UNAVAILABLE\n'); process.exitCode = 1; }); request.end();
