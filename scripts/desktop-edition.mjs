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
    .replace(/(<div id="root">)[\s\S]*?(<\/div>)/, `$1
      <main style="box-sizing:border-box;min-height:100vh;padding:80px 28px;background:#f5f0e6;color:#29251e;font:16px/1.7 system-ui,sans-serif">
        <h1 style="margin:0 0 12px;font-size:24px">正在打开本地日历…</h1>
        <p>如果长时间没有进入，请退出后重新打开终极日历本地版。</p>
        <p style="color:#726b60;font-size:14px">已有日历和资料会保留，请勿删除数据目录。</p>
        <small style="color:#726b60">诊断代码：UC-LOCAL-START-01</small>
      </main>
    $2`)
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
