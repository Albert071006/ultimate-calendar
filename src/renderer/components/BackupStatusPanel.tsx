import { useEffect, useState } from 'react';
import type { BackupProgress } from '../../shared/backup-progress';
import type { ApiResult } from '../../shared/contracts';
import { displayInstant } from '../calendar-layout';

export function BackupStatusPanel({ read, active = true, cloud }: {
  read?: () => Promise<ApiResult<BackupProgress>>; active?: boolean; cloud: boolean;
}) {
  const [status, setStatus] = useState<BackupProgress | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!active || !read) return;
    let live = true, running = false;
    async function refresh() {
      if (running) return;
      running = true;
      try { const result = await read!(); if (live) { setError(!result.ok); if (result.ok) setStatus(result.data); } }
      catch { if (live) setError(true); }
      finally { running = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [read, active]);
  if (!read) return null;
  return <div className="backup-status" aria-label="自动备份状态">
    <p><strong>{!status ? error ? '备份状态暂时无法读取' : '正在读取自动备份状态…' : status.running ? '正在后台备份' : status?.status === 'failed' ? '自动备份失败，等待重试' : status?.pending ? '有修改等待后台备份' : status?.lastSuccessAt ? '自动备份已完成' : '尚无成功的自动备份记录'}</strong></p>
    {status?.lastSuccessAt && <p>最近成功备份：{displayInstant(status.lastSuccessAt)}</p>}
    {error && <p role="status">暂时无法读取备份状态，稍后自动重试。</p>}
    <p className="fine-print">{cloud ? '修改立即保存到数据库，约一分钟内尝试合并生成后台备份，保留最近 7 份有效自动备份。' : '修改立即保存到数据库。包含采集原文的完整备份每天生成一次，在后台执行，按空间清理设置保留。'}</p>
  </div>;
}
