import type { RemoteClientState } from '../remote/types';

const needsHand = ['conflict', 'review', 'failed', 'uncertain', 'blocked'];

function cachedLabel(value: string | null) {
  if (!value) return '';
  const instant = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}+08:00`);
  if (Number.isNaN(instant.getTime())) return '';
  const local = new Date(instant.getTime() + 8 * 3600_000).toISOString();
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  return local.slice(0, 10) === today ? local.slice(11, 16) : `${Number(local.slice(5, 7))}月${Number(local.slice(8, 10))}日 ${local.slice(11, 16)}`;
}

/** Says nothing while the phone is connected and has nothing waiting; otherwise one line naming what is wrong. */
export function StatusBanner({ connection, onOpen }: { connection: Pick<RemoteClientState, 'status' | 'pending' | 'cachedAt' | 'storageError'>; onOpen: () => void }) {
  const { status, pending, cachedAt, storageError } = connection;
  const waiting = pending.length, stuck = pending.filter(item => needsHand.includes(item.status)).length;
  const lead = storageError ? '手机存储异常，修改可能无法暂存'
    : status === 'connecting' ? `正在更新${cachedLabel(cachedAt) ? ` · 显示 ${cachedLabel(cachedAt)} 的资料` : ''}`
    : status === 'offline' ? `离线${cachedLabel(cachedAt) ? ` · 显示 ${cachedLabel(cachedAt)} 的资料` : ''}`
    : status === 'error' ? '云端连接异常'
    : '';
  const queue = stuck ? `${stuck} 项修改需要处理` : waiting ? `${waiting} 项修改待提交` : '';
  if (!lead && !queue) return null;
  return (
    <button className={`m-banner${storageError || stuck || status === 'error' ? ' warn' : ''}`} role="status" onClick={onOpen}>
      <span>{[lead, queue].filter(Boolean).join(' · ')}</span><b>查看</b>
    </button>
  );
}
