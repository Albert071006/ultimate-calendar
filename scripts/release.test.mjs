import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { dump } from 'js-yaml';
import { releaseArtifactNames, verifyReleaseArtifacts, writeChecksums } from './release-artifacts.mjs';
import { publishRelease, validateTag } from './release.mjs';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-calendar-release-test-'));
  directories.push(directory);
  const version = '1.2.3', [installer, blockmap] = releaseArtifactNames(version), bytes = Buffer.from('MZ synthetic test installer');
  await writeFile(join(directory, installer), bytes);
  await writeFile(join(directory, blockmap), gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [bytes.length], checksums: ['c3ludGhldGlj'] }] })));
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const metadata = { version, files: [{ url: installer, sha512, size: bytes.length }], path: installer, sha512, releaseDate: '2026-01-01T00:00:00Z' };
  await writeFile(join(directory, 'latest.yml'), dump(metadata));
  await writeChecksums(directory, version);
  return { directory, version, metadata, installer, blockmap };
}

describe('release artifact verification', () => {
  it('accepts exactly the generated installer, update metadata, blockmap and checksum list', async () => {
    const { directory, version } = await fixture();
    expect((await verifyReleaseArtifacts(directory, version)).map(file => file.name)).toEqual(releaseArtifactNames(version));
  });
  it('rejects mismatched versions and unexpected tag names', () => {
    expect(() => validateTag('1.2.3', 'v1.2.3')).not.toThrow();
    expect(() => validateTag('1.2.3', 'v1.2.2')).toThrow('tag must');
    expect(() => validateTag('1.2.3-beta.1', 'v1.2.3-beta.1')).toThrow('stable');
  });
  it('rejects a modified installer even if a checksum manifest is regenerated', async () => {
    const { directory, version, installer } = await fixture();
    await writeFile(join(directory, installer), 'MZ changed test installer!');
    await writeChecksums(directory, version);
    await expect(verifyReleaseArtifacts(directory, version)).rejects.toThrow('SHA-512');
  });
  it('rejects an external installer URL in update metadata', async () => {
    const { directory, version, metadata } = await fixture();
    metadata.files[0].url = 'https://example.invalid/unexpected.exe';
    await writeFile(join(directory, 'latest.yml'), dump(metadata));
    await writeChecksums(directory, version);
    await expect(verifyReleaseArtifacts(directory, version)).rejects.toThrow('exactly the versioned');
  });
  it('rejects a stale checksum manifest', async () => {
    const { directory, version } = await fixture();
    await writeFile(join(directory, 'latest.yml'), `${await readFile(join(directory, 'latest.yml'), 'utf8')}\n# changed\n`);
    await expect(verifyReleaseArtifacts(directory, version)).rejects.toThrow('SHA256SUMS');
  });
  it('rejects a blockmap that does not cover the installer', async () => {
    const { directory, version, blockmap } = await fixture();
    await writeFile(join(directory, blockmap), gzipSync(JSON.stringify({ version: '2', files: [{ offset: 0, sizes: [1], checksums: ['c3ludGhldGlj'] }] })));
    await writeChecksums(directory, version);
    await expect(verifyReleaseArtifacts(directory, version)).rejects.toThrow('blockmap');
  });
});

function githubMock({ failUpload = false, omitFinalAsset = false } = {}) {
  const calls = [], assets = [];
  const draft = { id: 7, draft: true, tag_name: 'v1.2.3', target_commitish: 'a'.repeat(40), upload_url: 'https://uploads.github.com/repos/Albert071006/ultimate-calendar/releases/7/assets{?name,label}', html_url: 'https://github.com/Albert071006/ultimate-calendar/releases/tag/v1.2.3' };
  let assetReads = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    const path = new URL(url).pathname;
    if (path.endsWith('/tags/v1.2.3')) return Response.json({}, { status: 404 });
    if (options.method === 'POST' && path.endsWith('/releases')) return Response.json(draft);
    if (options.method === 'GET' && path.endsWith('/assets')) {
      assetReads++;
      return Response.json(omitFinalAsset && assetReads > 1 ? assets.slice(1) : assets);
    }
    if (options.method === 'POST' && url.startsWith('https://uploads.github.com/')) {
      if (failUpload) return Response.json({}, { status: 502 });
      const asset = { id: assets.length + 1, name: new URL(url).searchParams.get('name'), state: 'uploaded', size: options.body.length, digest: `sha256:${createHash('sha256').update(options.body).digest('hex')}` };
      assets.push(asset);
      return Response.json(asset);
    }
    if (options.method === 'PATCH') return Response.json({ ...draft, draft: false, prerelease: false });
    throw Error(`Unexpected request: ${options.method} ${url}`);
  };
  return { calls, fetchImpl };
}

describe('draft then publish workflow', () => {
  it('publishes only after all four uploaded bytes and remote digests are checked', async () => {
    const { directory, version } = await fixture(), api = githubMock();
    const artifacts = await verifyReleaseArtifacts(directory, version);
    const result = await publishRelease({ version, commit: 'a'.repeat(40), notes: 'Synthetic notes', token: 'synthetic-test-token', artifacts, fetchImpl: api.fetchImpl });
    expect(result.alreadyPublished).toBe(false);
    expect(JSON.parse(api.calls.find(call => call.method === 'POST' && call.url.endsWith('/releases')).body).draft).toBe(true);
    expect(api.calls.filter(call => call.url.startsWith('https://uploads.github.com/'))).toHaveLength(4);
    expect(api.calls.at(-1).method).toBe('PATCH');
    expect(JSON.parse(api.calls.at(-1).body).draft).toBe(false);
  });
  it.each([{ failUpload: true }, { omitFinalAsset: true }])('leaves the release as a draft on failure: %j', async options => {
    const { directory, version } = await fixture(), api = githubMock(options);
    const artifacts = await verifyReleaseArtifacts(directory, version);
    await expect(publishRelease({ version, commit: 'a'.repeat(40), notes: 'Synthetic notes', token: 'synthetic-test-token', artifacts, fetchImpl: api.fetchImpl })).rejects.toThrow();
    expect(api.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
});
