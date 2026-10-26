import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import { hashFile, prepareReleaseArtifacts, publicationArtifactNames, releaseArtifactNames, verifyLocalPublicationArtifacts, verifyReleaseArtifacts, writeChecksums } from './release-artifacts.mjs';
import { publishRelease, validateTag } from './release.mjs';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(edition = 'standard') {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-calendar-release-test-')); directories.push(directory);
  const version = '1.2.3', [installer, blockmap, metadataName] = releaseArtifactNames(version, edition), bytes = Buffer.from(`MZ synthetic ${edition} test installer`);
  await writeFile(join(directory, installer), bytes);
  await writeFile(join(directory, blockmap), gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [bytes.length], checksums: ['c3ludGhldGlj'] }] })));
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const metadata = { version, files: [{ url: installer, sha512, size: bytes.length }], path: installer, sha512, releaseDate: '2026-01-01T00:00:00Z', releaseNotes: `${edition} synthetic notes` };
  await writeFile(join(directory, metadataName), dump(metadata)); await writeChecksums(directory, version, edition);
  return { directory, version, metadata, metadataName, installer, blockmap };
}
async function bothEditions() {
  const standard = await fixture(), local = await fixture('local');
  await prepareReleaseArtifacts(standard.version, standard.directory, local.directory);
  // Archive structure has its own tests. These bytes exercise immutable publication.
  const bundle = [];
  for (const name of publicationArtifactNames(standard.version, 'server').slice(-2)) {
    const path = join(standard.directory, name), bytes = Buffer.from(`synthetic archive fixture ${name}`); await writeFile(path, bytes);
    bundle.push({ name, path, size: bytes.length, sha256: await hashFile(path) });
  }
  return { ...standard, local, artifacts: { local: await verifyLocalPublicationArtifacts(standard.version, standard.directory, local.directory), server: [...await verifyReleaseArtifacts(standard.directory, standard.version), ...bundle] } };
}
describe('release artifact verification', () => {
  it('accepts the generated installer, update metadata, blockmap and checksum list', async () => {
    const f = await fixture(); expect((await verifyReleaseArtifacts(f.directory, f.version)).map(file => file.name)).toEqual(releaseArtifactNames(f.version));
  });
  it('keeps local and server installers in separate publication asset sets', async () => {
    const f = await bothEditions();
    for (const edition of ['local', 'server']) expect(f.artifacts[edition].map(file => file.name)).toEqual(publicationArtifactNames(f.version, edition));
    expect(f.artifacts.local.filter(file => file.name.endsWith('.exe')).map(file => file.name)).toEqual([f.local.installer]);
    expect(f.artifacts.server.filter(file => file.name.endsWith('.exe')).map(file => file.name)).toEqual([f.installer]);
  });
  it('uses the actual GitHubProvider to resolve each edition to exactly its intended release', async () => {
    const f = await bothEditions();
    const provider = channel => new GitHubProvider({ provider: 'github', owner: 'Albert071006', repo: 'ultimate-calendar', channel }, { allowPrerelease: false }, { platform: 'win32', executor: {} });
    const route = load(await readFile(join(f.local.directory, 'latest.yml'), 'utf8'), { schema: JSON_SCHEMA });
    const localInfo = load(await readFile(join(f.local.directory, 'local.yml'), 'utf8'), { schema: JSON_SCHEMA });
    expect(provider('latest').resolveFiles({ ...route, tag: `v${f.version}` })[0].url.href).toBe(`https://github.com/Albert071006/ultimate-calendar/releases/download/server-v${f.version}/${f.installer}`);
    expect(provider('local').resolveFiles({ ...localInfo, tag: `v${f.version}` })[0].url.href).toBe(`https://github.com/Albert071006/ultimate-calendar/releases/download/v${f.version}/${f.local.installer}`);
    expect(route.sha512).toBe(f.metadata.sha512); expect(route.files[0].size).toBe(f.metadata.files[0].size); expect(route.releaseNotes).toBe(f.metadata.releaseNotes);
  });
  it.each(['../server-v9.9.9/UltimateCalendar-Setup-1.2.3.exe', 'https://example.invalid/setup.exe'])('rejects an unexpected route even after rehashing: %s', async url => {
    const f = await bothEditions(), route = load(await readFile(join(f.local.directory, 'latest.yml'), 'utf8'), { schema: JSON_SCHEMA });
    route.path = route.files[0].url = url; await writeFile(join(f.local.directory, 'latest.yml'), dump(route)); await writeChecksums(f.local.directory, f.version, 'local', true);
    await expect(verifyLocalPublicationArtifacts(f.version, f.directory, f.local.directory)).rejects.toThrow('Legacy update route');
  });
  it('includes the compatibility route in the local checksum manifest', async () => {
    const f = await bothEditions(); await writeFile(join(f.local.directory, 'latest.yml'), 'changed route');
    await expect(verifyLocalPublicationArtifacts(f.version, f.directory, f.local.directory)).rejects.toThrow('SHA256SUMS-local');
  });
  it('rejects local update metadata pointing at the standard installer', async () => {
    const f = await fixture('local'); f.metadata.path = f.metadata.files[0].url = releaseArtifactNames(f.version)[0];
    await writeFile(join(f.directory, f.metadataName), dump(f.metadata)); await writeChecksums(f.directory, f.version, 'local');
    await expect(verifyReleaseArtifacts(f.directory, f.version, 'local')).rejects.toThrow('versioned local installer');
  });
  it('rejects mismatched versions and unexpected trigger tags', () => {
    expect(() => validateTag('1.2.3', 'v1.2.3')).not.toThrow(); expect(() => validateTag('1.2.3', 'server-v1.2.3')).toThrow('tag must'); expect(() => validateTag('1.2.3-beta.1', 'v1.2.3-beta.1')).toThrow('stable');
  });
  it('rejects modified installer bytes even after regenerating the checksum manifest', async () => {
    const f = await fixture(); await writeFile(join(f.directory, f.installer), 'MZ changed test installer!'); await writeChecksums(f.directory, f.version);
    await expect(verifyReleaseArtifacts(f.directory, f.version)).rejects.toThrow('SHA-512');
  });
  it('rejects a stale checksum manifest', async () => {
    const f = await fixture(); await writeFile(join(f.directory, 'latest.yml'), `${await readFile(join(f.directory, 'latest.yml'), 'utf8')}\n# changed\n`);
    await expect(verifyReleaseArtifacts(f.directory, f.version)).rejects.toThrow('SHA256SUMS');
  });
  it('rejects a blockmap that does not cover the installer', async () => {
    const f = await fixture(); await writeFile(join(f.directory, f.blockmap), gzipSync(JSON.stringify({ version: '2', files: [{ offset: 0, sizes: [1], checksums: ['c3ludGhldGlj'] }] }))); await writeChecksums(f.directory, f.version);
    await expect(verifyReleaseArtifacts(f.directory, f.version)).rejects.toThrow('blockmap');
  });
});

function githubMock(options = {}) {
  const calls = [], releases = new Map(), assets = new Map();
  const tags = new Map([['v1.2.3', { object: { type: 'commit', sha: 'a'.repeat(40) } }]]);
  if (options.wrongServerTag) tags.set('server-v1.2.3', { object: { type: 'commit', sha: 'b'.repeat(40) } });
  let sequence = 7, latest = { tag_name: 'v1.2.2', draft: false, prerelease: false }, failedLocalPublication = false;
  const fetchImpl = async (url, request) => {
    calls.push({ url, method: request.method, body: request.body });
    const path = new URL(url).pathname, method = request.method, body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    if (path.includes('/git/ref/tags/')) return tags.has(path.split('/git/ref/tags/')[1]) ? Response.json(tags.get(path.split('/git/ref/tags/')[1])) : Response.json({}, { status: 404 });
    if (method === 'POST' && path.endsWith('/git/refs')) { const ref = { ref: body.ref, object: { type: 'commit', sha: body.sha } }; tags.set(body.ref.slice('refs/tags/'.length), ref); return Response.json(ref); }
    if (path.endsWith('/releases/latest')) return Response.json(latest);
    if (path.includes('/releases/tags/')) return releases.has(path.split('/releases/tags/')[1]) ? Response.json(releases.get(path.split('/releases/tags/')[1])) : Response.json({}, { status: 404 });
    if (method === 'POST' && path.endsWith('/releases')) {
      const release = { ...body, id: sequence++, upload_url: `https://uploads.github.com/repos/Albert071006/ultimate-calendar/releases/${sequence - 1}/assets{?name,label}`, html_url: `https://github.com/Albert071006/ultimate-calendar/releases/tag/${body.tag_name}` };
      releases.set(body.tag_name, release); assets.set(release.id, []); return Response.json(release);
    }
    if (method === 'DELETE' && path.includes('/releases/assets/')) { const id = Number(path.split('/').at(-1)); for (const [releaseId, list] of assets) assets.set(releaseId, list.filter(asset => asset.id !== id)); return new Response(null, { status: 204 }); }
    const releaseId = Number(path.match(/\/releases\/(\d+)/)?.[1]), release = [...releases.values()].find(item => item.id === releaseId);
    if (method === 'GET' && path.endsWith('/assets')) return Response.json(options.omitFinalAsset && assets.get(releaseId).length ? assets.get(releaseId).slice(1) : assets.get(releaseId));
    if (method === 'POST' && url.startsWith('https://uploads.github.com/')) {
      if (options.failUpload === true || options.failUpload === 'local' && release.tag_name === 'v1.2.3') return Response.json({}, { status: 502 });
      const list = assets.get(releaseId), asset = { id: releaseId * 100 + list.length, name: new URL(url).searchParams.get('name'), state: 'uploaded', size: body.length, digest: `sha256:${createHash('sha256').update(body).digest('hex')}` }; list.push(asset); return Response.json(asset);
    }
    if (method === 'PATCH') {
      if (options.failLocalPublishOnce && release.tag_name === 'v1.2.3' && !failedLocalPublication) { failedLocalPublication = true; return Response.json({}, { status: 503 }); }
      Object.assign(release, body); if (body.make_latest === 'true') latest = release; return Response.json(release);
    }
    throw Error(`Unexpected request: ${method} ${url}`);
  };
  return { calls, releases, assets, fetchImpl };
}
const publication = (fixture, api) => ({ version: fixture.version, commit: 'a'.repeat(40), notes: { local: 'Local synthetic notes', server: 'Server synthetic notes' }, token: 'synthetic-test-token', artifacts: fixture.artifacts, fetchImpl: api.fetchImpl });

describe('separate server and local release transaction', () => {
  it('verifies eleven assets before publishing server first and local Latest second', async () => {
    const f = await bothEditions(), api = githubMock(), result = await publishRelease(publication(f, api));
    expect(result.server.alreadyPublished).toBe(false); expect(result.local.alreadyPublished).toBe(false);
    const patches = api.calls.filter(call => call.method === 'PATCH');
    expect(patches.map(call => JSON.parse(call.body).make_latest)).toEqual(['false', 'true']);
    expect(JSON.parse(patches[0].body).name).toContain('服务器版'); expect(JSON.parse(patches[1].body).name).toContain('本地版');
    expect(api.calls.filter(call => call.url.startsWith('https://uploads.github.com/'))).toHaveLength(11);
    expect(api.calls.slice(api.calls.indexOf(patches[0])).some(call => call.url.startsWith('https://uploads.github.com/'))).toBe(false);
    expect(api.calls.at(-1).url).toMatch(/releases\/latest$/);
    expect(JSON.parse(api.calls.find(call => call.method === 'POST' && call.url.endsWith('/git/refs')).body)).toEqual({ ref: 'refs/tags/server-v1.2.3', sha: 'a'.repeat(40) });
  });
  it('refuses incomplete editions and duplicate attachment names before making network requests', async () => {
    const f = await bothEditions(), api = githubMock(), request = publication(f, api);
    await expect(publishRelease({ ...request, artifacts: { ...f.artifacts, server: f.artifacts.server.slice(0, 4) } })).rejects.toThrow('both complete editions');
    await expect(publishRelease({ ...request, artifacts: { ...f.artifacts, local: [...f.artifacts.local.slice(0, 4), f.artifacts.local[0]] } })).rejects.toThrow('both complete editions'); expect(api.calls).toHaveLength(0);
  });
  it('refuses a server tag pointing to another commit without replacing it', async () => {
    const f = await bothEditions(), api = githubMock({ wrongServerTag: true }); await expect(publishRelease(publication(f, api))).rejects.toThrow('different commit'); expect(api.calls.some(call => call.method !== 'GET')).toBe(false);
  });
  it.each([{ failUpload: true }, { failUpload: 'local' }, { omitFinalAsset: true }])('keeps releases as drafts until every asset is checked: %j', async options => {
    const f = await bothEditions(), api = githubMock(options); await expect(publishRelease(publication(f, api))).rejects.toThrow(); expect(api.calls.some(call => call.method === 'PATCH')).toBe(false); expect([...api.releases.values()].every(release => release.draft)).toBe(true);
  });
  it('recovers failed local publication without rewriting published server assets', async () => {
    const f = await bothEditions(), api = githubMock({ failLocalPublishOnce: true }), request = publication(f, api); await expect(publishRelease(request)).rejects.toThrow('HTTP 503');
    expect(api.releases.get('server-v1.2.3').draft).toBe(false); expect(api.releases.get('v1.2.3').draft).toBe(true);
    const offset = api.calls.length, serverId = api.releases.get('server-v1.2.3').id, result = await publishRelease(request);
    expect(result.server.alreadyPublished).toBe(true); expect(result.local.alreadyPublished).toBe(false);
    expect(api.calls.slice(offset).filter(call => call.url.includes(`/releases/${serverId}/`) || call.url.endsWith(`/releases/${serverId}`)).every(call => call.method === 'GET')).toBe(true);
    expect(api.calls.slice(offset).filter(call => call.method === 'DELETE').every(call => Number(call.url.split('/').at(-1)) < serverId * 100 || Number(call.url.split('/').at(-1)) >= (serverId + 1) * 100)).toBe(true);
  });
  it('only reads both releases on a successful retry, preserving published bytes', async () => {
    const f = await bothEditions(), api = githubMock(), request = publication(f, api); await publishRelease(request); const offset = api.calls.length, result = await publishRelease(request);
    expect(result.local.alreadyPublished && result.server.alreadyPublished).toBe(true); expect(api.calls.slice(offset).every(call => call.method === 'GET')).toBe(true);
  });
});
