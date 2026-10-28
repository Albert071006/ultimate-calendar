import { useEffect, useState, type FormEvent } from 'react';
import type { Settings } from '../../shared/contracts';
import { reasoningOptions, supportsReasoningEffort, type ReasoningEffort } from '../../shared/ai-reasoning';
import { remoteOutputs } from '../../server/protocol';
import type { RemoteController } from './types';

/** Online, explicit settings writes. A lost reply is re-read, never resent. */
export function CloudModelSettings({ controller, online }: { controller: RemoteController; online: boolean }) {
  const [saved, setSaved] = useState<Settings | null>(null), [model, setModel] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort>('none'), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [unclear, setUnclear] = useState(false);
  function input(value?: unknown) {
    const session = controller.getState().session;
    if (!session || !online) throw Error('请先连接云端再修改设置。');
    return { requestId: crypto.randomUUID(), identity: session.identity, ...(value === undefined ? {} : { input: value }) };
  }
  async function read() {
    setBusy(true); setMessage('');
    try {
      const result = remoteOutputs.snapshot.parse(await controller.request('/api/v1/rpc/snapshot', input(), 'POST'));
      if (!result.ok) throw Error(result.error.message);
      setSaved(result.data.settings); setModel(result.data.settings.model); setEffort(result.data.settings.reasoningEffort ?? 'none'); setUnclear(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : '读取设置失败，请稍后重试。'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (online) void read(); }, [online]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!saved || unclear) return;
    setBusy(true); setMessage('');
    const settings = { ...saved, model, ...(saved.reasoningEffort !== undefined || effort !== 'none' ? { reasoningEffort: effort } : {}) };
    try {
      const result = remoteOutputs.saveSettings.parse(await controller.request('/api/v1/rpc/saveSettings', input({ settings, expectedSettings: saved }), 'POST'));
      if (!result.ok) { setUnclear(true); throw Error(result.error.message); }
      setSaved(result.data); setMessage('已保存；手机、电脑生活助手与本机群采集使用这份设置。');
    } catch (error) {
      setUnclear(true); setMessage(`${error instanceof Error ? error.message : '保存结果尚未确认。'} 请先重新读取设置核对，不会自动重发。`);
    } finally { setBusy(false); }
  }
  return <section className="m-settings" aria-label="模型与思考强度">
    <h3>模型与思考强度</h3>
    {saved && <form className="m-form" onSubmit={event => void save(event)}>
      <label>模型<select value={model} disabled={busy || !online} onChange={event => { setModel(event.target.value); if (!supportsReasoningEffort(event.target.value)) setEffort('none'); }}>
        {!supportsReasoningEffort(model) && <option value={model}>{model} · 当前模型</option>}
        <option value="deepseek-flash">DeepSeek Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
      </select></label>
      <label>思考强度<select value={effort} disabled={busy || !online || !supportsReasoningEffort(model)} onChange={event => setEffort(event.target.value as ReasoningEffort)}>
        {reasoningOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <p className="m-hint">{supportsReasoningEffort(model) ? '强度越高，通常耗时和用量越多。默认关闭，保存后才生效。' : '当前模型未确认支持强度调节，保持原来的非思考请求方式。'}</p>
      <button type="submit" className="m-btn primary" disabled={busy || !online || unclear}>保存 AI 设置</button>
    </form>}
    <button type="button" className="m-link" disabled={busy || !online} onClick={() => void read()}>重新读取 AI 设置</button>
    {message && <p className={`m-note ${unclear ? 'warn' : 'ok'}`} role="status">{message}</p>}
  </section>;
}
