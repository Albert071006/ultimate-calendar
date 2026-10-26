import type { Entity, JournalSummary, PreviewDetail } from '../shared/contracts';

const labels: Record<string, string> = { task: '任务', block: '活动', course: '课程', courseException: '课程调整', candidate: '候选', source: '消息来源', goal: '目标', preference: '偏好', feedback: '反馈' };
const fields: Record<string, string> = { resources: '关联资料', title: '标题', start: '开始', end: '结束', deadline: '截止', location: '地点', completed: '完成状态', cancelled: '取消状态', status: '状态', reminders: '提醒', timeEstimateMinutes: '预计时长', description: '说明', text: '内容', enabled: '启用状态', firstWeek: '起始周', lastWeek: '结束周', startTime: '开始时间', endTime: '结束时间', weekdays: '星期', weekday: '星期', weeks: '教学周', termStart: '学期开始', recurrence: '重复安排' };
const valueText = (value: unknown): string => {
  if (value == null || value === '') return '未设置';
  if (Array.isArray(value) && value.every(item => item && typeof item === 'object' && 'name' in item && 'kind' in item)) return value.length ? value.map(item => String(item.name)).join('、').slice(0, 180) : '无';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return ({ open: '待完成', done: '已完成', completed: '已完成', pending: '待判断', accepted: '已接受', ignored: '已忽略' }[value] ?? value.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?\+08:00$/, '')).slice(0,180);
  if (typeof value === 'object' && 'date' in value) return `${value.date} ${'time' in value && value.time ? value.time : '仅日期'}`;
  return JSON.stringify(value).slice(0,180);
};
const titleOf = (record: Entity | null) => {
  if (!record) return '';
  const value = 'title' in record ? record.title : 'text' in record ? record.text : 'label' in record ? record.label : '';
  return typeof value === 'string' ? value.slice(0,120) : '';
};
function operationTitle(detail: PreviewDetail): string {
  const label = labels[detail.entity] ?? '记录';
  const title = titleOf(detail.after ?? detail.before) || label;
  if (!detail.before || !detail.after) return `${!detail.before ? '新增' : '移除'}${label}「${title}」`;
  const before = detail.before as unknown as Record<string, unknown>, after = detail.after as unknown as Record<string, unknown>;
  if (before.title !== after.title) return `重命名${label}「${titleOf(detail.before) || label}」→「${title}」`;
  if (before.cancelled !== after.cancelled) return `${after.cancelled ? '取消' : '恢复'}${label}「${title}」`;
  if (before.completed !== after.completed || (before.status !== after.status && ['open', 'done', 'completed'].includes(String(after.status)))) {
    return `${after.completed || after.status === 'completed' || after.status === 'done' ? '完成' : '恢复待完成'}${label}「${title}」`;
  }
  if (['start', 'end', 'startTime', 'endTime', 'deadline'].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))) return `调整${label}「${title}」时间`;
  return `修改${label}「${title}」`;
}

/** Derive labels from durable before/after records, including operations created by old versions. */
export function describeJournal(journal: Pick<JournalSummary, 'operationId' | 'message'> & { details: PreviewDetail[] }) {
  const details = journal.details.filter(d => !['feedback', 'source'].includes(d.entity));
  const relevant = details.length ? details : journal.details;
  const lines = relevant.slice(0,20).map(d => {
    const title = titleOf(d.after ?? d.before) || labels[d.entity] || '记录';
    const prefix = `${!d.before ? '新增' : !d.after ? '移除' : '修改'}${labels[d.entity] ?? '记录'}「${title}」`;
    if (!d.before || !d.after) {
      const record = d.after ?? d.before;
      return `${prefix}${record && 'start' in record ? ` · ${valueText(record.start)}${'end' in record && record.end ? ` → ${valueText(record.end)}` : ''}` : ''}`;
    }
    const before = d.before as unknown as Record<string, unknown>, after = d.after as unknown as Record<string, unknown>;
    const changes = Object.keys(fields).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    return `${prefix}${changes.length ? `：${changes.slice(0,4).map(key => `${fields[key]} ${valueText(before[key])} → ${valueText(after[key])}`).join('；')}${changes.length > 4 ? '；另有变更' : ''}` : ''}`;
  });
  if (relevant.length > 20) lines.push(`另有 ${relevant.length - 20} 条记录随此操作一起变更`);
  const first = relevant[0];
  const title = first ? `${operationTitle(first)}${relevant.length > 1 ? `等 ${relevant.length} 条记录` : ''}` : journal.message;
  return { displayTitle: `${journal.operationId.startsWith('undo:') ? '撤销操作 · ' : ''}${title}`, displayDetails: lines };
}
