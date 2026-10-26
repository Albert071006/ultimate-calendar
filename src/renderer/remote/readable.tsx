import type { ReactNode } from 'react';
import type { PendingWrite, RecoveryArchive } from './types';

export const queueStates: Record<PendingWrite['status'], string> = { queued: '待提交', sending: '正在提交', uncertain: '结果待核对', conflict: '有冲突', review: '待确认', failed: '未保存', blocked: '等待前一项' };
export const resultUnknown = (item: PendingWrite) => ['uncertain', 'sending', 'interrupted'].includes(item.status);

const fields: Record<string, string> = { title:'名称',description:'说明',date:'日期',start:'开始时间',end:'结束时间',deadline:'截止时间',time:'时刻',kind:'类型',status:'状态',completed:'是否完成',location:'地点',taskId:'关联任务',goalId:'所属目标',courseId:'所属课程',expectedVersion:'基于版本',version:'版本',values:'修改内容',mutations:'修改事项',entries:'账目',entry:'账目',amountCents:'金额（分）',personalCents:'个人开销（分）',incomeCents:'收入（分）',cashflows:'账户资金变化',accountId:'账户',deltaCents:'变化金额（分）',reminders:'提醒',enabled:'启用',leadMinutes:'提前分钟',dateOnlyTime:'仅日期提醒时刻',frequency:'重复频率',scope:'修改范围',note:'备注',type:'操作',entity:'资料类型',before:'云端当前值',after:'拟保存值',changes:'具体变更',conflicts:'冲突',reason:'原因',id:'记录',createdAt:'创建时间',updatedAt:'更新时间',sourceIds:'来源',blocks:'执行时段',tasks:'任务',courses:'课程',goals:'目标',record:'记录',base:'修改前资料',records:'相关资料',seriesId:'重复系列',recurrence:'重复规则',cancelled:'是否取消',value:'内容',month:'月份',category:'分类',relatedEntryIds:'关联账目',dateNote:'日期说明',occurredAt:'发生时刻',transactionId:'操作记录',recordedAt:'登记时刻' };
const values: Record<string, string> = { work:'执行时段',event:'固定活动',task:'任务',block:'时段',course:'课程',goal:'目标',candidate:'候选事项',create:'新建',update:'修改',delete:'删除',open:'未完成',done:'已完成',active:'进行中',paused:'已暂停',completed:'已完成',single:'仅本次','this-and-following':'本次及以后',expense:'开销',income:'收入',transfer:'转账',manual:'手动操作' };
const hiddenField = /(?:token|password|secret|api.?key|imageDataUrl|originalText|sourceQuote|captureRef|^text$|^history$|wireInput|operationId|requestId|identity)/i;

/** Beijing time as "2026-10-24 14:12"; non-instant strings pass through. */
export function readableDate(value: string | null | undefined) {
  if (!value) return '暂无';
  if (!/^\d{4}-\d\d-\d\dT/.test(value)) return value;
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}+08:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** A queued write's data in plain labels, without credentials, raw source text or transport identifiers. */
export function Readable({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined) return <span className="remote-muted">未提供</span>;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return values[value] ?? readableDate(value);
  if (typeof value === 'number') return String(value);
  if (depth > 5) return '内容较多，未全部展开';
  if (Array.isArray(value)) return value.length ? <ol className="remote-readable-list">{value.slice(0, 30).map((item, index) => <li key={index}><Readable value={item} depth={depth + 1} /></li>)}</ol> : '无';
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([key]) => !hiddenField.test(key));
    return entries.length ? <dl className="remote-readable">{entries.map(([key, item]) => <div key={key}><dt>{fields[key] ?? '其他资料'}</dt><dd><Readable value={item} depth={depth + 1} /></dd></div>)}</dl> : '无可展示的字段';
  }
  return '未提供';
}

/** Saves an archive as a private local JSON file; nothing is uploaded or replayed. */
export function downloadArchive(archive: RecoveryArchive) {
  const payload = { format: 'ultimate-calendar-isolated-queue', formatVersion: 1, warning: '私密本机档案，未上传，也不会自动提交到新的配对。其中结果未知的操作可能已在原云端执行，请先核对，不要照抄重建。', archive };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `终极日历-本机档案-${archive.createdAt.slice(0, 10)}-${archive.id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12)}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Archived changes from an earlier pairing: read-only, exportable, never resent. */
export function ArchiveList({ archives, exported }: { archives: RecoveryArchive[]; exported?: () => void }) {
  if (!archives.length) return <p className="m-empty">没有本机档案。</p>;
  return <ul className="m-archives">{archives.map(archive => <li key={archive.id}>
    <details>
      <summary><strong>{archive.device.name} · {archive.pending.length} 项</strong><small>{readableDate(archive.createdAt)}</small></summary>
      {archive.pending.map(item => <div key={item.id} className="m-archive-item">
        <p><strong>{item.label}</strong> · {queueStates[item.status] ?? '结果待核对'}</p>
        {resultUnknown(item) && <p className="m-hint">可能已在原云端执行，请先核对，不要重新创建。</p>}
        <details><summary>修改内容</summary><Readable value={item.input} /></details>
      </div>)}
    </details>
    <button className="m-btn" onClick={() => { downloadArchive(archive); exported?.(); }}>导出</button>
  </li>)}</ul>;
}
