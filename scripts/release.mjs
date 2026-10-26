import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_REPOSITORY = 'Albert071006/ultimate-calendar';

export function validateTag(version, tag) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('A stable x.y.z version is required');
  if (tag !== `v${version}`) throw Error(`Release tag must be v${version}, received ${tag || '(empty)'}`);
}

function verifyRemoteAssets(assets, artifacts) {
  if (!Array.isArray(assets) || assets.length !== artifacts.length) throw Error('Release does not contain exactly the expected assets');
  for (const file of artifacts) {
    const matches = assets.filter(asset => asset.name === file.name);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== file.size
      || matches[0].digest !== `sha256:${file.sha256}`) throw Error(`Uploaded asset verification failed: ${file.name}`);
  }
}

// Stage and verify both drafts before publishing either. The server assets must
// be public before the local Latest release exposes the legacy update route.
export async function publishRelease({ version, commit, notes, artifacts, token, fetchImpl = fetch }) {
  const tag = `v${version}`;
  validateTag(version, tag);
  if (!token || !/^[a-f0-9]{40}$/.test(commit) || !notes?.local?.trim() || !notes?.server?.trim()) throw Error('Token, commit SHA and both release notes are required');
  const { publicationArtifactNames } = await import('./release-artifacts.mjs');
  for (const edition of ['local', 'server']) {
    const expectedNames = publicationArtifactNames(version, edition), files = artifacts?.[edition];
    if (!Array.isArray(files) || files.length !== expectedNames.length || expectedNames.some(name => files.filter(file => file.name === name).length !== 1))
      throw Error(`Unexpected ${edition} release artifact list: both complete editions are required`);
  }
  const base = `https://api.github.com/repos/${RELEASE_REPOSITORY}`;
  async function request(url, method = 'GET', body, binary = false, allowNotFound = false) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'uploads.github.com'].includes(parsed.hostname)
      || !parsed.pathname.startsWith(`/repos/${RELEASE_REPOSITORY}/`)) throw Error('Unexpected GitHub endpoint');
    const response = await fetchImpl(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(binary ? 10 * 60 * 1000 : 60 * 1000),
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'ultimate-calendar-release',
        ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
      }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw Error(`GitHub ${method} ${parsed.pathname} failed (HTTP ${response.status}); release remains unpublished if still draft`);
    return response.status === 204 ? null : response.json();
  }
  async function ensureTag(expectedTag, canCreate) {
    let ref = await request(`${base}/git/ref/tags/${expectedTag}`, 'GET', undefined, false, true);
    if (!ref) {
      if (!canCreate) throw Error(`Required release tag is missing: ${expectedTag}`);
      ref = await request(`${base}/git/refs`, 'POST', { ref: `refs/tags/${expectedTag}`, sha: commit });
    }
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++)
      object = (await request(`${base}/git/tags/${object.sha}`)).object;
    if (object?.type !== 'commit' || object.sha !== commit) throw Error(`Release tag points to a different commit: ${expectedTag}`);
  }
  await ensureTag(tag, false);
  await ensureTag(`server-v${version}`, true);
  const specifications = [
    { edition: 'server', tag: `server-v${version}`, name: `终极日历服务器版与手机端 ${version}`, makeLatest: 'false' },
    { edition: 'local', tag, name: `终极日历本地版 ${version}`, makeLatest: 'true' },
  ];
  const staged = [];
  for (const spec of specifications) {
    const files = artifacts[spec.edition];
    let release = await request(`${base}/releases/tags/${spec.tag}`, 'GET', undefined, false, true);
    if (release && (release.prerelease || release.tag_name !== spec.tag || (release.draft && release.target_commitish !== commit)))
      throw Error('Existing release belongs to a different commit or release type');
    if (release && !release.draft) {
      verifyRemoteAssets(await request(`${base}/releases/${release.id}/assets?per_page=100`), files);
      staged.push({ ...spec, release, alreadyPublished: true });
      continue;
    }
    if (!release) release = await request(`${base}/releases`, 'POST', {
      tag_name: spec.tag, target_commitish: commit, name: spec.name, body: notes[spec.edition],
      draft: true, prerelease: false,
    });
    if (!Number.isSafeInteger(release.id) || !release.draft || release.tag_name !== spec.tag) throw Error('GitHub did not create the expected draft release');
    const oldAssets = await request(`${base}/releases/${release.id}/assets?per_page=100`);
    // Only same-commit drafts may be replaced. Published assets above are read-only.
    for (const asset of oldAssets) await request(`${base}/releases/assets/${asset.id}`, 'DELETE');
    const upload = release.upload_url?.split('{')[0];
    if (!upload) throw Error('Draft release has no upload endpoint');
    for (const file of files) {
      const bytes = await readFile(file.path);
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        throw Error(`Release artifact changed after verification: ${file.name}`);
      const asset = await request(`${upload}?name=${encodeURIComponent(file.name)}`, 'POST', bytes, true);
      verifyRemoteAssets([asset], [file]);
    }
    verifyRemoteAssets(await request(`${base}/releases/${release.id}/assets?per_page=100`), files);
    staged.push({ ...spec, release, alreadyPublished: false });
  }
  if (staged[1].alreadyPublished && !staged[0].alreadyPublished) throw Error('Local release is public before its required server release');
  const result = {};
  for (const item of staged) {
    let published = item.release;
    if (!item.alreadyPublished) {
      await ensureTag(item.tag, false);
      published = await request(`${base}/releases/${item.release.id}`, 'PATCH', {
        draft: false, prerelease: false, make_latest: item.makeLatest, body: notes[item.edition], name: item.name,
      });
      if (published.draft || published.prerelease || published.tag_name !== item.tag) throw Error('GitHub publication status could not be confirmed');
      verifyRemoteAssets(await request(`${base}/releases/${item.release.id}/assets?per_page=100`), artifacts[item.edition]);
    }
    result[item.edition] = { url: published.html_url, alreadyPublished: item.alreadyPublished };
  }
  if (!result.local.alreadyPublished) {
    const latest = await request(`${base}/releases/latest`);
    if (latest.tag_name !== tag || latest.draft || latest.prerelease) throw Error('Local edition was not confirmed as the repository Latest release');
  }
  return result;
}

async function main() {
  const command = process.argv[2];
  if (!['check-tag', 'publish'].includes(command)) throw Error('Usage: node scripts/release.mjs check-tag|publish');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw Error('Package and lockfile versions differ');
  const tag = process.env.GITHUB_REF_NAME;
  validateTag(pkg.version, tag);
  if (process.env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY || process.env.GITHUB_REF_TYPE !== 'tag')
    throw Error('Release requires the official repository tag context');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  if (git('rev-parse', `refs/tags/${tag}^{}`) !== commit) throw Error('Tag does not point to the checked out commit');
  const notes = { local: await readFile(`docs/release-notes/${pkg.version}.md`, 'utf8'), server: await readFile(`docs/release-notes/server-${pkg.version}.md`, 'utf8') };
  if (!notes.local.trim() || !notes.server.trim()) throw Error('Release notes are empty');
  if (command === 'check-tag') { console.log(`Verified ${tag} at ${commit}`); return; }
  const { verifyAllReleaseArtifacts } = await import('./release-artifacts.mjs');
  const artifacts = await verifyAllReleaseArtifacts(pkg.version);
  const result = await publishRelease({ version: pkg.version, commit, notes, artifacts, token: process.env.GITHUB_TOKEN });
  for (const edition of ['server', 'local']) console.log(`${result[edition].alreadyPublished ? 'Verified existing' : 'Published'} ${edition} release: ${result[edition].url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
