import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { AppUpdates } from '../hooks/useAppUpdates';
import { displayInstant } from '../calendar-layout';
import { Modal } from './Modal';
import './SoftwareUpdate.css';

export function UpdateShortcut({ updates, open }: { updates: AppUpdates; open: () => void }) {
  const state = updates.state;
  if (!state || !['available', 'downloading', 'downloaded', 'installing', 'error'].includes(state.status)) return null;
  const label = state.status === 'available' ? `新版本 ${state.latestVersion ?? ''}`
    : state.status === 'downloading' ? `更新下载中${state.progressPercent === null ? '' : ` ${Math.round(state.progressPercent)}%`}`
    : state.status === 'downloaded' ? '重启更新'
    : state.status === 'installing' ? '正在安装更新' : '更新未完成';
  return <button type="button" className="update-shortcut" onClick={open} title="查看软件更新">
    <Download size={14} aria-hidden="true" />{label}
  </button>;
}

export function SoftwareUpdate({ updates, plannerBusy = false }: { updates: AppUpdates; plannerBusy?: boolean }) {
  const [confirmRestart, setConfirmRestart] = useState(false);
  const state = updates.state;
  const unavailable = !updates.supported || state?.status === 'unavailable';
  const downloading = state?.status === 'downloading' || updates.pending === 'download';
  const canDownload = state?.status === 'available' || (state?.status === 'error' && !!state.latestVersion);
  const message = updates.error || state?.message || (unavailable ? '当前环境未接入软件更新，请使用安装版查看。' : '正在读取更新状态…');
  const hasError = !!updates.error || state?.status === 'error';
  const percent = state?.progressPercent == null ? undefined : Math.min(100, Math.max(0, state.progressPercent));
  return <>
    <section className="software-update" aria-label="软件更新">
      <div className="software-update-heading">
        <div><h3>软件更新</h3><span className="software-version">终极日历{state?.currentVersion ? ` · v${state.currentVersion}` : ''}</span></div>
        <div className="toolbar wrap">
          <button type="button" disabled={unavailable || updates.busy} onClick={() => void updates.check()}>
            <RefreshCw size={13} aria-hidden="true" />{updates.pending === 'check' || state?.status === 'checking' ? '正在检查…' : hasError ? '重新检查' : '检查更新'}
          </button>
          {canDownload && <button type="button" className="primary" disabled={updates.busy} onClick={() => void updates.download()}>
            {hasError ? '重试下载' : `下载 v${state.latestVersion}`}
          </button>}
          {state?.status === 'downloaded' && <button type="button" className="primary" disabled={updates.busy || plannerBusy} onClick={() => setConfirmRestart(true)}>重启并安装</button>}
        </div>
      </div>
      <p className={hasError ? 'error software-update-status' : 'hint software-update-status'} role={hasError ? 'alert' : 'status'}>{message}</p>
      {downloading && <div className="software-update-progress"><progress aria-label="更新下载进度" max={100} value={percent} /><span>{percent === undefined ? '下载中…' : `${Math.round(percent)}%`}</span></div>}
      {state?.status === 'downloaded' && plannerBusy && <p className="hint">当前操作完成后即可重启安装。</p>}
      <div className="software-update-meta"><span>{unavailable ? '此环境不自动检查或安装更新。' : '启动后自动检查，下载和安装由你决定。'}</span>{state?.checkedAt && <span>上次检查：{displayInstant(state.checkedAt)}</span>}</div>
      {!!state?.releaseNotes && <details className="software-release-notes"><summary>更新说明{state.latestVersion ? ` · v${state.latestVersion}` : ''}</summary><p className="prewrap">{state.releaseNotes}</p></details>}
    </section>
    {confirmRestart && <Modal title="重启并安装更新" onClose={() => { if (updates.pending !== 'install') setConfirmRestart(false); }}>
      <p>安装更新会关闭并重新启动终极日历。请先保存正在编辑的表单和对话输入框中的草稿；未保存内容不会保留。</p>
      <p className="hint">已保存的日历、账单、QQ 采集资料和密钥会保留。</p>
      {!!updates.error && <p className="error" role="alert">{updates.error}</p>}
      {plannerBusy && <p className="hint">请等待当前操作完成。</p>}
      <footer className="modal-actions">
        <button type="button" disabled={updates.pending === 'install'} onClick={() => setConfirmRestart(false)}>返回保存</button>
        <button type="button" className="primary" disabled={updates.busy || plannerBusy || state?.status !== 'downloaded'} onClick={() => void updates.install().then(ok => { if (ok) setConfirmRestart(false); })}>
          {updates.pending === 'install' || state?.status === 'installing' ? '正在安装…' : '已保存，重启安装'}
        </button>
      </footer>
    </Modal>}
  </>;
}
