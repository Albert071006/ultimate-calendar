import { describe, expect, it } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createServerMobileArchive, readServerMobileArchive } from './package-server-mobile.mjs';

const names = ['LICENSE', 'README.md', 'dist-server/cli.mjs', 'deploy/server-mobile/ultimate-calendar.service', 'deploy/nginx.conf.example', 'deploy/check-health.mjs', 'docs/server-mobile-deployment.md', 'docs/windows-cloud-mode.md', 'docs/backend-operations.md', 'scripts/retain-web-assets.mjs', 'web/index.html', 'web/sw.js', 'web/manifest.webmanifest', 'web/assets/app-synthetic.js'];
const files = () => names.map(name => ({ name, bytes: Buffer.from(name === 'dist-server/cli.mjs' ? 'server-core-test' : `synthetic ${name}`) }));
describe('standalone server and mobile archive', () => {
  it('contains a versioned server, mobile shell, service unit and deployment instructions', () => {
    const bundle = createServerMobileArchive('0.5.0', files());
    const { entries, manifest } = readServerMobileArchive(bundle, '0.5.0');
    expect(manifest).toMatchObject({ version: '0.5.0', nodeMajor: 24, entrypoint: 'dist-server/cli.mjs', staticDirectory: 'web' });
    expect(entries.get('dist-server/cli.mjs').toString()).toBe('server-core-test');
    expect(entries.size).toBe(names.length + 1);
    expect(createServerMobileArchive('0.5.0', files())).toEqual(bundle);
  });
  it.each(['credentials/key.bin', 'web/../planner.sqlite', 'web/.env', 'web/assets/.env', 'web/assets/key.bin', 'deploy/secrets.env'])('refuses private or escaping input %s', name => {
    expect(() => createServerMobileArchive('0.5.0', [...files(), { name, bytes: Buffer.from('private') }])).toThrow('Unapproved');
  });
  it('rejects missing mobile files and duplicate names', () => {
    expect(() => createServerMobileArchive('0.5.0', files().filter(f => f.name !== 'web/index.html'))).toThrow('missing');
    expect(() => createServerMobileArchive('0.5.0', [...files(), files()[0]])).toThrow('duplicate');
  });
  it('rejects cross-version archives and modified content before extraction', () => {
    const bundle = createServerMobileArchive('0.5.0', files());
    expect(() => readServerMobileArchive(bundle, '0.5.1')).toThrow('another release');
    const raw = gunzipSync(bundle), offset = raw.indexOf('server-core-test'); raw[offset] = 88;
    expect(() => readServerMobileArchive(gzipSync(raw), '0.5.0')).toThrow('manifest');
  });
});
