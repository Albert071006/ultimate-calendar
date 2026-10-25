import { useEffect, useRef, useState } from 'react';
import { AiApiKeySchema, type AiConfigurationStatus } from '../../shared/ai-configuration';
import type { PlannerUI } from '../hooks/usePlanner';

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
  return <div className="settings-page">
    <section className="settings-card settings-group" aria-labelledby="cloud-ai-title">
      <div className="settings-group-heading"><h3 id="cloud-ai-title">生活助手 API Key</h3><span>DeepSeek · 云端共用</span></div>
      <p>手机、电脑生活助手和 QQ 提炼共用这份密钥。在任一端修改一次，其他端会自动更新；电脑离线时会在重新连接后补同步。</p>
      <p className={status?.configured ? 'success' : 'hint'}>
        {status ? status.configured ? '云端已配置 · 不显示完整密钥' : '云端尚未配置 API Key' : '正在读取云端配置…'}
      </p>
      {status && !status.editable && <p className="warning">密钥由服务器配置管理，当前不能在设备上修改。</p>}
      {error && <p role="alert" className="warning">{error}</p>}
      {message && <p role="status" className="hint">{message}</p>}
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>API Key<input ref={input} type="password" autoComplete="off" spellCheck={false}
          disabled={disabled} maxLength={512} placeholder={status?.configured ? '填写新的 Key 可替换云端配置' : '输入 DeepSeek API Key'} /></label>
        <div className="toolbar">
          <button className="primary" type="submit" disabled={disabled}>保存云端密钥</button>
          <button type="button" disabled={busy || ui.busy} onClick={() => void refresh()}>重新读取云端配置</button>
          <button type="button" disabled={disabled || !status?.configured} onClick={() => setConfirmClear(true)}>清除云端密钥</button>
        </div>
      </form>
      {confirmClear && <div role="group" aria-label="确认清除云端密钥" className="warning">
        <p>清除后，手机和电脑的生活助手都需要重新配置密钥才能使用；本机 QQ 提炼密钥也会同步清除。</p>
        <div className="toolbar"><button type="button" disabled={disabled} onClick={() => void save(true)}>确认清除两端共用密钥</button>
          <button type="button" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button></div>
      </div>}
      <p className="fine-print">密钥不回填、不进入日历备份或操作历史。QQ 提炼只在这台已授权的采集电脑接收并加密保存密钥；QQ 原文和附件仍留在本机。</p>
    </section>
  </div>;
}
