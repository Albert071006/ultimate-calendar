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
  if (!Array.isArray(assets) || assets.length !== artifacts.length) throw Error('Release does not contain exactly the four expected assets');
  for (const file of artifacts) {
    const matches = assets.filter(asset => asset.name === file.name);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== file.size
      || matches[0].digest !== `sha256:${file.sha256}`) throw Error(`Uploaded asset verification failed: ${file.name}`);
  }
}

// Publication is deliberately separate from electron-builder. Keep a release in
// draft until every attachment and GitHub's returned digest have been verified.
export async function publishRelease({ version, commit, notes, artifacts, token, fetchImpl = fetch }) {
  const tag = `v${version}`;
  validateTag(version, tag);
  if (!token || !/^[a-f0-9]{40}$/.test(commit) || !notes.trim()) throw Error('Token, commit SHA and release notes are required');
  const { releaseArtifactNames } = await import('./release-artifacts.mjs');
  const expectedNames = releaseArtifactNames(version);
  if (artifacts.length !== 4 || expectedNames.some(name => !artifacts.some(file => file.name === name))) throw Error('Unexpected release artifact list');
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
  let release = await request(`${base}/releases/tags/${tag}`, 'GET', undefined, false, true);
  if (release && !release.draft) {
    if (release.prerelease) throw Error('Existing release is a prerelease');
    verifyRemoteAssets(await request(`${base}/releases/${release.id}/assets?per_page=100`), artifacts);
    return { url: release.html_url, alreadyPublished: true };
  }
  if (release && (release.target_commitish !== commit || release.prerelease || release.tag_name !== tag))
    throw Error('Existing draft belongs to a different commit or release type');
  if (!release) release = await request(`${base}/releases`, 'POST', {
    tag_name: tag, target_commitish: commit, name: `终极日历 ${tag}`, body: notes,
    draft: true, prerelease: false,
  });
  if (!Number.isSafeInteger(release.id) || !release.draft || release.tag_name !== tag) throw Error('GitHub did not create the expected draft release');
  const oldAssets = await request(`${base}/releases/${release.id}/assets?per_page=100`);
  // Retry only a draft at this exact commit; never replace published binaries.
  for (const asset of oldAssets) await request(`${base}/releases/assets/${asset.id}`, 'DELETE');
  const upload = release.upload_url?.split('{')[0];
  if (!upload) throw Error('Draft release has no upload endpoint');
  for (const file of artifacts) {
    const bytes = await readFile(file.path);
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw Error(`Release artifact changed after verification: ${file.name}`);
    const asset = await request(`${upload}?name=${encodeURIComponent(file.name)}`, 'POST', bytes, true);
    verifyRemoteAssets([asset], [file]);
  }
  verifyRemoteAssets(await request(`${base}/releases/${release.id}/assets?per_page=100`), artifacts);
  const published = await request(`${base}/releases/${release.id}`, 'PATCH', {
    draft: false, prerelease: false, make_latest: 'true', body: notes,
  });
  if (published.draft || published.prerelease || published.tag_name !== tag) throw Error('GitHub publication status could not be confirmed');
  return { url: published.html_url, alreadyPublished: false };
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
  const notes = await readFile(`docs/release-notes/${pkg.version}.md`, 'utf8');
  if (!notes.trim()) throw Error('Release notes are empty');
  if (command === 'check-tag') { console.log(`Verified ${tag} at ${commit}`); return; }
  const { verifyReleaseArtifacts } = await import('./release-artifacts.mjs');
  const artifacts = await verifyReleaseArtifacts('release', pkg.version);
  const result = await publishRelease({ version: pkg.version, commit, notes, artifacts, token: process.env.GITHUB_TOKEN });
  console.log(`${result.alreadyPublished ? 'Verified existing' : 'Published'} release: ${result.url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
