import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import { archiveRelease, hashFile, prepareReleaseArtifacts, publicationArtifactNames, releaseArtifactNames, verifyArchivedRelease, verifyLocalPublicationArtifacts, verifyReleaseArtifacts, writeChecksums } from './release-artifacts.mjs';
import { createServerMobileArchive } from './package-server-mobile.mjs';
import { backendRuntimeFiles } from '../deploy/backend-files.mjs';
import { RELEASE_REPOSITORY, publishRelease, selectReleaseBuild, validateTag } from './release.mjs';

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
  const inputs = ['README.md', 'LICENSE', ...backendRuntimeFiles, 'deploy/server-mobile/ultimate-calendar.service', 'deploy/nginx.conf.example',
    'deploy/check-health.mjs', 'docs/server-mobile-deployment.md', 'docs/windows-cloud-mode.md', 'docs/backend-operations.md',
    'scripts/retain-web-assets.mjs', 'web/index.html', 'web/sw.js', 'web/manifest.webmanifest'];
  const [bundleName, checksumName] = publicationArtifactNames(standard.version, 'server').slice(-2);
  const bytes = createServerMobileArchive(standard.version, inputs.map(name => ({ name, bytes: Buffer.from('synthetic ' + name) })));
  await writeFile(join(standard.directory, bundleName), bytes);
  await writeFile(join(standard.directory, checksumName), `${createHash('sha256').update(bytes).digest('hex')}  ${bundleName}\n`);
  const bundle = [];
  for (const name of [bundleName, checksumName]) {
    const path = join(standard.directory, name);
    bundle.push({ name, path, size: (await readFile(path)).length, sha256: await hashFile(path) });
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
    if (path.includes('/releases/tags/')) {
      const release = releases.get(path.split('/releases/tags/')[1]);
      return release && !release.draft ? Response.json(release) : Response.json({}, { status: 404 });
    }
    if (method === 'GET' && path.endsWith('/releases')) return Response.json([...releases.values()]);
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

describe('release build selection', () => {
  const push = { id: 42, event: 'push', path: '.github/workflows/release.yml', head_sha: 'a'.repeat(40), repository: { full_name: RELEASE_REPOSITORY } };
  const name = 'release-v1.2.3-42';
  function select({ resume = false, run = push, artifacts = [], jobs = [], published = false } = {}) {
    return selectReleaseBuild({ version: '1.2.3', commit: push.head_sha, runId: resume ? '99' : '42', sourceRunId: resume ? '42' : undefined,
      resume, token: 'synthetic-test-token', fetchImpl: async (url, request) => {
        if (request.method !== 'GET') throw Error('Build selection must be read-only');
        const endpoint = new URL(url);
        if (endpoint.pathname.endsWith('/actions/runs/42')) return Response.json(run);
        if (endpoint.pathname.endsWith('/actions/runs/42/artifacts') && endpoint.searchParams.get('name') === name)
          return Response.json({ total_count: artifacts.length, artifacts });
        if (endpoint.pathname.endsWith('/actions/runs/42/jobs')) return Response.json({ jobs });
        if (endpoint.pathname.includes('/releases/tags/')) return published ? Response.json({ draft: false }) : Response.json({}, { status: 404 });
        if (endpoint.pathname.endsWith('/releases')) return Response.json([]);
        throw Error('Unexpected synthetic endpoint');
      } });
  }
  it('builds once, then reuses the push artifact on both re-run all jobs and explicit resume', async () => {
    expect(await select()).toEqual({ buildId: '42', name, build: true });
    for (const resume of [false, true]) expect(await select({ resume, artifacts: [{ name, expired: false }] })).toEqual({ buildId: '42', name, build: false });
  });
  it('stops on missing, expired or wrong-origin archives without rebuilding a published edition', async () => {
    await expect(select({ resume: true })).rejects.toThrow('missing or expired');
    await expect(select({ published: true })).rejects.toThrow('original archived build');
    await expect(select({ artifacts: [{ name, expired: true }] })).rejects.toThrow('expired');
    const retry = { run: { ...push, run_attempt: 2 } };
    await expect(select({ ...retry, jobs: [{ name: 'build', conclusion: 'success' }] })).rejects.toThrow('after a successful build');
    expect(await select({ ...retry, jobs: [{ name: 'build', conclusion: 'failure' }] })).toMatchObject({ build: true });
    for (const overrides of [{ event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { head_sha: 'b'.repeat(40) }])
      await expect(select({ resume: true, run: { ...push, ...overrides } })).rejects.toThrow('workflow and commit');
  });
  it('wires publication to the selected workflow artifact with a fresh runner and no build steps', async () => {
    const { jobs } = load(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'), { schema: JSON_SCHEMA });
    const upload = jobs.build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    const download = jobs.publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    const archive = jobs.build.steps.find(step => step.run === 'node scripts/release.mjs archive');
    const publish = jobs.publish.steps.find(step => step.run === 'npm run release:publish');
    expect(jobs.build.permissions?.contents).not.toBe('write');
    expect(jobs.publish.needs).toEqual(['source', 'build']);
    expect(upload.with.path).toBe(archive.env.RELEASE_ARCHIVE_DIR + '/');
    expect(download.with.name).toBe(upload.with.name);
    expect(download.with['run-id']).toBe(publish.env.RELEASE_BUILD_ID);
    expect(download.with.path).toBe(publish.env.RELEASE_ARCHIVE_DIR);
    expect(jobs.publish.steps.map(step => step.run).filter(Boolean)).toEqual(['npm ci --ignore-scripts', 'npm run release:publish']);
  });
});

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
  it('publishes the remaining draft on a fresh runner from the original archive even if rebuilding changes releaseDate', async () => {
    const f = await bothEditions(), api = githubMock({ failLocalPublishOnce: true }), request = publication(f, api);
    const identity = { version: f.version, commit: request.commit, buildId: '12345' };
    const sealed = join(f.directory, 'sealed'), downloaded = join(f.local.directory, 'downloaded');
    const first = await archiveRelease(sealed, identity, f.directory, f.local.directory, f.directory);
    await expect(publishRelease({ ...request, artifacts: first })).rejects.toThrow('HTTP 503');
    expect(api.releases.get('server-v1.2.3').draft).toBe(false); expect(api.releases.get('v1.2.3').draft).toBe(true);
    await cp(sealed, downloaded, { recursive: true });
    f.metadata.releaseDate = '2026-01-03T00:00:00Z';
    await writeFile(join(f.directory, f.metadataName), dump(f.metadata)); await writeChecksums(f.directory, f.version);
    const rebuilt = await verifyReleaseArtifacts(f.directory, f.version);
    await expect(publishRelease({ ...request, artifacts: { ...f.artifacts, server: [...rebuilt, ...f.artifacts.server.slice(-2)] } })).rejects.toThrow('Uploaded asset verification failed');
    await expect(verifyArchivedRelease(downloaded, { ...identity, buildId: '54321' })).rejects.toThrow('identity');
    await expect(verifyArchivedRelease(downloaded, { ...identity, commit: 'b'.repeat(40) })).rejects.toThrow('identity');
    const resumed = await verifyArchivedRelease(downloaded, identity);
    const offset = api.calls.length, serverId = api.releases.get('server-v1.2.3').id, result = await publishRelease({ ...request, artifacts: resumed });
    expect(result.server.alreadyPublished).toBe(true); expect(result.local.alreadyPublished).toBe(false);
    expect(api.calls.slice(offset).filter(call => call.url.includes(`/releases/${serverId}/`) || call.url.endsWith(`/releases/${serverId}`)).every(call => call.method === 'GET')).toBe(true);
    expect(api.calls.slice(offset).filter(call => call.method === 'DELETE').every(call => Number(call.url.split('/').at(-1)) < serverId * 100 || Number(call.url.split('/').at(-1)) >= (serverId + 1) * 100)).toBe(true);
    expect(api.calls.slice(offset).filter(call => call.method !== 'GET').map(call => call.method)).toEqual(['PATCH']);
    for (const [edition, tag] of [['local', 'v1.2.3'], ['server', 'server-v1.2.3']]) {
      const uploaded = api.assets.get(api.releases.get(tag).id);
      expect(uploaded.map(file => [file.name, file.digest])).toEqual(first[edition].map(file => [file.name, 'sha256:' + file.sha256]));
    }
    await writeFile(join(downloaded, 'local', 'local.yml'), 'changed bytes');
    await expect(verifyArchivedRelease(downloaded, identity)).rejects.toThrow();
  });
  it('only reads both releases on a successful retry, preserving published bytes', async () => {
    const f = await bothEditions(), api = githubMock(), request = publication(f, api); await publishRelease(request); const offset = api.calls.length, result = await publishRelease(request);
    expect(result.local.alreadyPublished && result.server.alreadyPublished).toBe(true); expect(api.calls.slice(offset).every(call => call.method === 'GET')).toBe(true);
  });
});
