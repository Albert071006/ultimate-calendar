import { useEffect, useState } from 'react';
import type { DesktopAPI, Source } from '../../shared/contracts';
import { displayInstant } from '../calendar-layout';
import { QQSearchActions } from './QQSearchActions';

/** Local evidence is deliberately separate from the shared, mutable planner snapshot. */
export function LocalSourceViewer({ sourceId, host, onClose, onCapture }: {
  sourceId: string; host: Pick<DesktopAPI, 'localSourceEvidence'>; onClose(): void; onCapture?: (reference: NonNullable<Source['captureRef']>) => void;
}) {
  const [sources, setSources] = useState<Source[] | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let live = true; setSources(null); setError('');
    void host.localSourceEvidence({ sourceId }).then(result => {
      if (!live) return;
      if (result.ok) setSources(result.data.sources); else setError(result.error.message);
    }).catch(() => { if (live) setError('本机采集服务暂不可用，请确认已启动后重新打开来源。'); });
    return () => { live = false; };
  }, [host, sourceId]);
  return <div className="editor-form">
    <p className="hint">以下资料来自这台电脑，原文和附件不会上传到云端。</p>
    {!sources && !error && <p role="status">正在读取本机来源…</p>}
    {error && <p className="warning" role="alert">{error}</p>}
    {sources?.map(source => <section key={source.id}>
      <h4>{source.label || '本机来源'}</h4>
      <p>发送时间：{source.sentAt ? displayInstant(source.sentAt) : '未提供'} · 导入时间：{displayInstant(source.importedAt)}</p>
      {source.captureRef && <><p>依据位置：{source.captureRef.locator}</p>{onCapture && <button onClick={() => onCapture(source.captureRef!)}>查看本机采集记录与附件</button>}<QQSearchActions evidence={{ groupId: source.captureRef.groupId, sentAt: source.sentAt, text: source.text, attachment: Boolean(source.captureRef.attachmentId || source.captureRef.transcribed) }} /></>}
      {source.imageDataUrl && <img className="source-image" src={source.imageDataUrl} alt="本机保存的原始截图" />}
      {source.text && <pre className="original-text">{source.text}</pre>}
      {!source.text && !source.imageDataUrl && <p>这份来源未保留正文，可通过采集记录核对。</p>}
    </section>)}
    <button onClick={onClose}>关闭来源详情</button>
  </div>;
}
