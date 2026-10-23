import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, delimiter, dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DOCUMENT_LIMITS, DocumentError, assertActive, type LegacyConverter } from './types';

export type LibreOfficeConfig = { sofficePath: string; pythonPath: string; pythonPathEnvironment?: string[]; helperPath?: string };

// Supplied to LibreOffice's own Python/pyuno runtime. No document code is executed.
export const UNO_CONVERT_SCRIPT = String.raw`
import json, os, sys, time
import uno, unohelper
from com.sun.star.beans import PropertyValue
from com.sun.star.task import XInteractionHandler
from com.sun.star.document.MacroExecMode import NEVER_EXECUTE
from com.sun.star.document.UpdateDocMode import NO_UPDATE

class RejectInteractions(unohelper.Base, XInteractionHandler):
    def __init__(self): self.password = False
    def handle(self, interaction):
        request = interaction.getRequest()
        name = getattr(request, 'typeName', type(request).__name__)
        if 'password' in name.lower(): self.password = True
        for continuation in interaction.getContinuations():
            abort = continuation.queryInterface(uno.getTypeByName('com.sun.star.task.XInteractionAbort'))
            if abort: abort.select(); return

def prop(name, value):
    item = PropertyValue(); item.Name = name; item.Value = value; return item

pipe, source, target, filter_name = sys.argv[1:]
handler = RejectInteractions()
desktop = None
document = None
try:
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    context = None
    for attempt in range(100):
        try:
            context = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
            break
        except Exception:
            time.sleep(0.2)
    if context is None: raise RuntimeError('connection unavailable')
    desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
    document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(source), '_blank', 0, (
        prop('Hidden', True), prop('ReadOnly', True), prop('MacroExecutionMode', NEVER_EXECUTE),
        prop('UpdateDocMode', NO_UPDATE), prop('InteractionHandler', handler),
        prop('AllowLinkUpdate', False), prop('AsTemplate', False), prop('Silent', True),
    ))
    if document is None: raise RuntimeError('document unavailable')
    if hasattr(document, 'enableAutomaticCalculation'): document.enableAutomaticCalculation(False)
    document.storeToURL(uno.systemPathToFileUrl(target), (prop('FilterName', filter_name), prop('Overwrite', True)))
    print(json.dumps({'ok': True}))
except Exception:
    print(json.dumps({'ok': False, 'encrypted': handler.password}))
    sys.exit(2 if handler.password else 1)
finally:
    try:
        if document: document.close(True)
    except Exception: pass
    try:
        if desktop: desktop.terminate()
    except Exception: pass
`;

async function finish(child: ChildProcess, signal: AbortSignal, limit = 8192): Promise<{ code: number; output: string }> {
  return await new Promise((resolveResult, reject) => {
    let output = '';
    const abort = () => { child.kill(); reject(new DocumentError('旧版 Office 转换超时或已取消', 'needs-review')); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (data: Buffer) => { output += data.toString('utf8'); if (output.length > limit) { child.kill(); reject(new DocumentError('转换组件返回异常内容')); } });
    // stderr can include document text/paths; consume it without logging or returning it.
    child.stderr?.on('data', () => {});
    child.once('error', () => { signal.removeEventListener('abort', abort); reject(new DocumentError('旧版 Office 转换组件无法启动', 'needs-review')); });
    child.once('exit', code => { signal.removeEventListener('abort', abort); resolveResult({ code: code ?? 1, output }); });
    if (signal.aborted) abort();
  });
}

export function createLibreOfficeConverter(config: LibreOfficeConfig): LegacyConverter {
  return async (input, incomingSignal) => {
    const extension = extname(input.name).slice(1).toLowerCase();
    const formats: Record<string, string> = { doc: 'Office Open XML Text', xls: 'Calc MS Excel 2007 XML', ppt: 'Impress MS PowerPoint 2007 XML' };
    const filter = formats[extension];
    if (!filter) throw new DocumentError('转换器不支持此文档格式', 'unsupported');
    if (input.bytes.length > DOCUMENT_LIMITS.inputBytes) throw new DocumentError('文件超过 25 MB 自动处理限额', 'needs-review');
    const timer = AbortSignal.timeout(DOCUMENT_LIMITS.timeoutMs), signal = incomingSignal ? AbortSignal.any([incomingSignal, timer]) : timer;
    assertActive(signal);
    try { await Promise.all([stat(config.sofficePath), stat(config.pythonPath)]); }
    catch { throw new DocumentError('LibreOffice 或其 Python 组件缺失，旧版 Office 文件需手动查看', 'needs-review'); }
    const root = await mkdtemp(join(tmpdir(), 'ultimate-calendar-office-'));
    const profile = join(root, 'profile'), source = join(root, `source.${extension}`), target = join(root, `converted.${extension}x`), helper = join(root, 'convert.py');
    const pipe = `ultimatecalendar_${randomUUID().replaceAll('-', '')}`;
    let office: ChildProcess | undefined;
    try {
      await mkdir(profile);
      await Promise.all([writeFile(source, input.bytes), writeFile(helper, UNO_CONVERT_SCRIPT, 'utf8')]);
      // A dedicated profile and private pipe isolate conversion from any interactive LibreOffice session.
      office = spawn(config.sofficePath, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--nodefault', '--nolockcheck', '--nofirststartwizard', `--accept=pipe,name=${pipe};urp;StarOffice.ComponentContext`], { windowsHide: true, stdio: 'ignore' });
      let officeFailure = false; office.once('error', () => { officeFailure = true; });
      const pythonPath = [...(config.pythonPathEnvironment ?? []), dirname(config.sofficePath)].join(delimiter);
      const worker = spawn(config.pythonPath, [helper, pipe, source, target, filter], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: pythonPath, PYTHONIOENCODING: 'utf-8' } });
      const result = await finish(worker, signal);
      if (result.code === 2) throw new DocumentError('Office 文档已加密，需先手动解密', 'encrypted');
      if (result.code || officeFailure || !result.output.includes('"ok": true')) throw new DocumentError('旧版 Office 转换失败，文件可能损坏或不受支持', 'needs-review');
      const info = await stat(target);
      if (info.size > DOCUMENT_LIMITS.inputBytes) throw new DocumentError('旧版 Office 转换结果超过 25 MB 处理限额', 'needs-review');
      return { bytes: await readFile(target), name: `converted.${extension}x` };
    } finally {
      if (office && office.exitCode === null) office.kill();
      // Only the exact fresh temporary directory created above is eligible for cleanup.
      const resolvedRoot = resolve(root), resolvedTemp = resolve(tmpdir());
      if (resolvedRoot.startsWith(resolvedTemp + sep) && resolvedRoot.slice(resolvedTemp.length + 1).startsWith('ultimate-calendar-office-')) await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
  };
}
