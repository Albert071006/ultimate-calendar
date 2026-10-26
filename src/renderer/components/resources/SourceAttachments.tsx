import { useEffect, useState } from 'react';
import { FileText, Paperclip } from 'lucide-react';
import type { HostCapabilities } from '../../../shared/client';
import type { SourceAttachment } from '../../../shared/source-attachments';
import './ResourcePanel.css';

type LinkedAttachment = SourceAttachment & { sourceIds: string[] };

/** Resolve local source links on demand; shared records never receive file paths or file contents. */
export function SourceAttachments({ sourceIds, host }: { sourceIds: string[]; host?: HostCapabilities }) {
  const [state, setState] = useState<{ key: string; files: LinkedAttachment[]; unavailable: number; error: string } | null>(null);
  const [opening, setOpening] = useState(''), [openError, setOpenError] = useState(''), [revision, setRevision] = useState(0);
  const key = JSON.stringify([...new Set(sourceIds)].sort());
  useEffect(() => {
    let active = true; setOpenError(''); setOpening('');
    if (!host?.sourceAttachments || !sourceIds.length) { setState(null); return; }
    const load = host.sourceAttachments;
    setState(null);
    void (async () => {
      const ids: string[] = JSON.parse(key), files = new Map<string, LinkedAttachment>();
      let unavailable = 0;
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const result = await load({ sourceIds: batch });
        if (!active) return;
        if (!result.ok) throw Error(result.error.message);
        unavailable += result.data.unavailableSources;
        for (const file of result.data.attachments) {
          const previous = files.get(file.id);
          if (!previous || previous.status !== 'available' && file.status === 'available') files.set(file.id, { ...file, sourceIds: batch });
        }
      }
      if (active) setState({ key, files: [...files.values()], unavailable, error: '' });
    })().catch(error => { if (active) setState({ key, files: [], unavailable: 0, error: error instanceof Error ? error.message : '暂时无法读取本机附件' }); });
    return () => { active = false; };
  }, [host, key, revision]);
  if (!host?.sourceAttachments || !sourceIds.length) return null;
  const current = state?.key === key ? state : null;
  if (current && !current.files.length && !current.error && !current.unavailable) return null;
  async function open(file: LinkedAttachment) {
    if (!host?.sourceAttachmentOpen) return;
    setOpening(file.id); setOpenError('');
    try {
      const result = await host.sourceAttachmentOpen({ sourceIds: file.sourceIds, attachmentId: file.id });
      if (!result.ok) setOpenError(result.error.message);
    } catch { setOpenError('未能打开附件，请检查本机采集服务和默认应用后重试。'); }
    finally { setOpening(''); }
  }
  return <section className="source-attachments" aria-label="通知附件">
    <h4><Paperclip aria-hidden="true" />附件资料</h4>
    {!current && <p className="hint" role="status">正在读取附件…</p>}
    {current?.files.length ? <ul className="resource-list">{current.files.map(file => <li key={file.id}>
      <button type="button" className="source-attachment-open" aria-label={`打开附件 ${file.name}`}
        disabled={file.status !== 'available' || !host.sourceAttachmentOpen || Boolean(opening)}
        onKeyDown={event => { if (!event.ctrlKey && !event.metaKey && !event.altKey && ['a', 'i', 'l', 'arrowup', 'arrowdown'].includes(event.key.toLowerCase())) event.stopPropagation(); }}
        onClick={() => void open(file)}><FileText aria-hidden="true" /><span>{file.name}</span>{opening === file.id && <small>正在打开…</small>}</button>
      {file.status !== 'available' && <small className="source-attachment-state">{file.message || (file.status === 'missing' ? '本机附件缺失' : '此文件类型不能直接打开')}</small>}
    </li>)}</ul> : null}
    {Boolean(current?.unavailable) && <p className="hint">部分原始资料不在这台电脑，暂时无法读取其附件。</p>}
    {current?.error && <p className="resource-error" role="alert">{current.error} <button type="button" className="ui-btn sm ghost" onClick={() => setRevision(value => value + 1)}>重试读取</button></p>}
    {openError && <p className="resource-error" role="alert">{openError}</p>}
  </section>;
}
