// Offline Caddyfile adaptation only. Does not install, provision TLS, start or reload Caddy.
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const [binary, ...extra] = process.argv.slice(2);
if (!binary || extra.length || !isAbsolute(binary) || !statSync(binary).isFile()) {
  throw Error('Usage: node deploy/public-https/check-template.mjs <absolute-path-to-verified-caddy>');
}
const run = args => {
  const result = spawnSync(binary, args, {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, CALENDAR_PUBLIC_HOST: 'calendar.example.org', CALENDAR_BIND_IP: '10.0.0.10', ACME_EMAIL: 'operator@example.org' },
  });
  if (result.error || result.status !== 0) throw Error('Caddy command failed; inspect the verified binary and template locally.');
  return result.stdout;
};
const version = run(['version']).trim();
if (!/^v2\.11\.7(?:\s|$)/.test(version)) throw Error('This review targets official Caddy v2.11.7; review the template before using another version.');
// Do NOT add --validate: adaptation parses syntax without provisioning modules or certificates.
const config = JSON.parse(run(['adapt', '--adapter', 'caddyfile', '--config', fileURLToPath(new URL('Caddyfile.example', import.meta.url)), '--pretty']));
const servers = Object.values(config.apps?.http?.servers ?? {});
const listeners = servers.flatMap(value => value.listen ?? []).sort();
if (JSON.stringify(listeners) !== JSON.stringify(['10.0.0.10:443', '10.0.0.10:80'])) throw Error('Unexpected HTTP listener binding.');
if (servers.some(value => value.protocols?.includes('h3'))) throw Error('HTTP/3 must remain disabled.');
if (config.admin?.listen !== '127.0.0.1:2019') throw Error('Caddy administration listener must stay on loopback.');
const proxies = [], paths = [];
function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.handler === 'reverse_proxy') proxies.push(value);
  if (Array.isArray(value.path)) paths.push(...value.path);
  for (const nested of Object.values(value)) walk(nested);
}
walk(config);
if (proxies.length !== 1 || proxies[0].upstreams?.length !== 1 || proxies[0].upstreams[0].dial !== '127.0.0.1:3210') throw Error('Unexpected upstream.');
const headers = proxies[0].headers?.request?.set ?? {};
if (Object.keys(headers).some(name => ['host', 'origin'].includes(name.toLowerCase()))) throw Error('Host and Origin must not be rewritten.');
if (headers['X-Forwarded-For']?.[0] !== '{http.request.remote.host}') throw Error('Forwarded client IP must be overwritten from the actual socket.');
for (const path of ['/healthz', '/readyz', '/api/v1/status', '/api/v1/distilled', '/api/v1/ai/receiver/sync']) {
  if (!paths.includes(path) || !paths.includes(path + '/*')) throw Error('A private route guard is missing.');
}
console.log(JSON.stringify({ version, templateAdapted: true, listeners, loopbackUpstream: true, originPreserved: true,
  privateRoutesGuarded: true, networkListenersStarted: false, certificatesRequested: false, liveDeploymentVerified: false }, null, 2));
