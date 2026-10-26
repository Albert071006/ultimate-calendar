export function desktopEdition(args = process.argv.slice(2)) {
  const flags = args.filter(value => value.startsWith('--edition'));
  if (!flags.length) return 'standard';
  if (flags.length !== 1 || !['--edition=standard', '--edition=local'].includes(flags[0]))
    throw Error('Desktop edition must be --edition=standard or --edition=local');
  return flags[0].slice('--edition='.length);
}

export function localDesktopHtml(html) {
  if (!html.includes('/src/renderer/main.tsx')) throw Error('Desktop HTML entry is missing');
  return html
    .replace('/src/renderer/main.tsx', '/src/renderer/desktop-main.tsx')
    .replace(/\s*<meta name="apple-mobile-web-app-[^"]+"[^>]*>/g, '')
    .replace(/\s*<link rel="(?:manifest|apple-touch-icon)"[^>]*>/g, '')
    .replace('<title>终极日历</title>', '<title>终极日历本地版</title>');
}

export function desktopViteOptions(edition) {
  if (edition !== 'local') return {};
  return { publicDir: false, plugins: [{ name: 'local-desktop-entry', transformIndexHtml: { order: 'pre', handler: localDesktopHtml } }] };
}

export function localPackageConfig() {
  return {
    appId: 'local.ultimate-calendar.local-desktop',
    productName: '终极日历本地版',
    executableName: '终极日历本地版',
    extraMetadata: { name: 'ultimate-calendar-local', productName: '终极日历本地版' },
    directories: { output: 'release-local' },
    nsis: { artifactName: 'UltimateCalendar-Local-Setup-${version}.${ext}' },
    publish: { provider: 'github', owner: 'Albert071006', repo: 'ultimate-calendar', private: false, channel: 'local', releaseType: 'release', tagNamePrefix: 'v' },
    generateUpdatesFilesForAllChannels: false,
  };
}
