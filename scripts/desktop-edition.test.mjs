import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { desktopEdition, localDesktopHtml, localPackageConfig } from './desktop-edition.mjs';

describe('standalone desktop distribution', () => {
  it('keeps existing builds standard and rejects malformed or ambiguous edition flags', () => {
    expect(desktopEdition([])).toBe('standard');
    expect(desktopEdition(['--edition=local'])).toBe('local');
    for (const args of [['--edition'], ['--edition=unknown'], ['--edition=local', '--edition=standard']])
      expect(() => desktopEdition(args)).toThrow('Desktop edition');
  });
  it('uses a desktop-only entry and excludes PWA installation metadata from the actual HTML', async () => {
    const html = localDesktopHtml(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
    expect(html).toContain('/src/renderer/desktop-main.tsx');
    expect(html).not.toContain('/src/renderer/main.tsx');
    expect(html).not.toMatch(/apple-mobile-web-app|rel="manifest"|rel="apple-touch-icon"/);
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('终极日历本地版');
  });
  it('gives the local installer its own identity and update metadata channel', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const local = localPackageConfig();
    expect(local.appId).not.toBe(pkg.build.appId);
    expect(local.productName).not.toBe(pkg.build.productName);
    // electron-builder derives the downloaded-installer cache from package.name.
    expect(local.extraMetadata.name).not.toBe(pkg.name);
    expect(local.publish.channel).not.toBe(pkg.build.publish.channel);
    expect(local.generateUpdatesFilesForAllChannels).toBe(false);
  });
});
