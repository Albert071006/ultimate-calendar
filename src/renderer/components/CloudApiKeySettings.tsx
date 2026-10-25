import { useEffect, useRef, useState } from 'react';
import { AiApiKeySchema, type AiConfigurationStatus } from '../../shared/ai-configuration';
import type { PlannerUI } from '../hooks/usePlanner';
import './CloudApiKeySettings.css';

/** The value is submitted once, never kept in component state or read back from the service. */
export function CloudApiKeySettings({ ui }: { ui: PlannerUI }) {
  const host = ui.host;
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const [status, setStatus] = useState<AiConfigurationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  async function readStatus() {
    if (!host) throw Error('Cloud host unavailable');
    const result = await host.retryApiKey();
    if (!result.ok || !result.data.cloudConfiguration) throw Error('Cloud status unavailable');
    if (alive.current) setStatus(result.data.cloudConfiguration);
    return result.data.cloudConfiguration;
  }
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage(''); setConfirmClear(false);
    try {
      await readStatus();
      if (alive.current) { setNeedsReview(false); setMessage('已读取云端当前配置。'); }
    } catch {
      if (alive.current) { setNeedsReview(true); setError('无法读取云端配置，请检查连接后重新读取。'); }
    } finally {
      inFlight.current = false; if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; if (input.current) input.current.value = ''; };
  }, [host]);

  useEffect(() => {
    const observe = async () => {
      // Preserve the revision associated with an in-progress edit or deletion confirmation.
      if (inFlight.current || confirmClear || input.current?.value) return;
      inFlight.current = true;
      try { await readStatus(); } catch { /* A background read never resubmits a secret or removes a review guard. */ }
      finally { inFlight.current = false; }
    };
    const timer = window.setInterval(() => void observe(), 5000);
    window.addEventListener('focus', observe);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', observe); };
  }, [host, confirmClear]);

  async function save(clear = false) {
    if (!host || !status?.editable || needsReview || inFlight.current || ui.busy) return;
    const key = clear ? null : AiApiKeySchema.safeParse(input.current?.value ?? '');
    if (key !== null && !key.success) { setError('请输入有效的 API Key（16–512 个字符，不含空格）。'); return; }
    inFlight.current = true; setBusy(true); setError(''); setMessage(''); setConfirmClear(false);
    // Clear the input before awaiting the main process; no key is placed in UI notices or a retry queue.
    const value = key === null ? null : key.data;
    if (input.current) input.current.value = '';
    try {
      const result = await host.setApiKey({ key: value, expectedRevision: status.revision });
      if (result.ok && result.data.cloudConfiguration) {
        if (alive.current) {
          setStatus(result.data.cloudConfiguration); setNeedsReview(false);
          setMessage(clear ? '云端密钥已清除，手机和电脑的生活助手将共同停用这份密钥。' : '云端密钥已保存，手机和电脑的生活助手共用。');
        }
        void ui.refresh().catch(() => {});
      } else {
        if (alive.current) {
          setNeedsReview(true);
          setError(!result.ok && result.error.code === 'CONFLICT'
            ? '云端配置已变更，本次未覆盖。请重新读取，再按需填写。'
            : !result.ok && result.error.code === 'VALIDATION'
              ? result.error.message
              : !result.ok && result.error.code === 'AUTH'
                ? '设备授权已失效，请重新配对后读取配置。'
                : '本次保存结果尚未确认，已尝试核对云端状态，未自动重发。请重新读取后再决定是否修改。');
        }
        // Reads are safe after an uncertain write. A refreshed configured flag does not prove which key won.
        try { await readStatus(); } catch { /* Keep the review guard until an explicit successful refresh. */ }
      }
    } catch {
      if (alive.current) { setNeedsReview(true); setError('本次保存结果尚未确认，未自动重发。请重新读取云端配置。'); }
      try { await readStatus(); } catch { /* No write retry. */ }
    } finally {
      inFlight.current = false; if (alive.current) setBusy(false);
    }
  }
  const disabled = busy || ui.busy || !status?.editable || needsReview;
  const state = !status ? 'loading' : status.configured ? 'on' : 'off';
  return <div className="settings-page">
    <section className="settings-card settings-group cloud-key" aria-labelledby="cloud-ai-title">
      <div className="settings-group-heading"><h3 id="cloud-ai-title">生活助手 API Key</h3><span>DeepSeek · 云端共用</span></div>
      <p className="ck-lead">手机、电脑的生活助手和 QQ 提炼共用这一份密钥，任一端修改后其他端自动更新。</p>
      <div className="ck-status">
        <i className={`ck-dot ${state}`} aria-hidden="true" />
        <strong>{status ? status.configured ? '云端已配置 · 不显示完整密钥' : '云端尚未配置 API Key' : '正在读取云端配置…'}</strong>
        {message && <span role="status" className="ck-note">{message}</span>}
        <button type="button" className="ui-btn sm ghost" aria-label="重新读取云端配置" disabled={busy || ui.busy} onClick={() => void refresh()}>重新读取</button>
      </div>
      {status && !status.editable && <p className="warning">密钥由服务器配置管理，当前不能在设备上修改。</p>}
      {error && <p role="alert" className="warning">{error}</p>}
      <form className="ck-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <input ref={input} type="password" aria-label="API Key" autoComplete="off" spellCheck={false}
          disabled={disabled} maxLength={512} placeholder={status?.configured ? '填写新的 Key 可替换云端配置' : '输入 DeepSeek API Key'} />
        <button className="ui-btn primary" type="submit" aria-label="保存云端密钥" disabled={disabled}>保存</button>
        <button type="button" className="ui-btn ghost ck-clear" disabled={disabled || !status?.configured} onClick={() => setConfirmClear(true)}>清除云端密钥</button>
      </form>
      {confirmClear && <div role="group" aria-label="确认清除云端密钥" className="ck-confirm">
        <p>清除后，手机和电脑的生活助手都要重新填写密钥才能使用，这台电脑上 QQ 提炼用的密钥也会一起清除。</p>
        <div className="ck-buttons"><button type="button" className="ui-btn sm" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button>
          <button type="button" className="ui-btn sm primary" disabled={disabled} onClick={() => void save(true)}>确认清除两端共用密钥</button></div>
      </div>}
      <p className="ck-fine">密钥保存后不会再显示，也不会进入日历备份或操作历史；QQ 原文和附件仍只留在这台电脑。</p>
    </section>
  </div>;
}
