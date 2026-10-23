import type { Block, Entity, MutationResult } from "../../shared/contracts";
import { effectiveActivityEnd } from '../../domain/activity-duration';
import { displayInstant } from "../calendar-layout";
import { entityNames } from "./DetailPanel";
const labels: Record<string, string> = {
  title: "名称",
  description: "说明",
  status: "状态",
  deadline: "截止（日期 / 时刻）",
  start: "开始",
  end: "结束",
  eventStart: "活动开始",
  eventEnd: "活动结束",
  location: "地点",
  action: "行动",
  benefit: "收益",
  potentialBenefit: "潜在收益",
  firstWeek: "起始教学周",
  lastWeek: "结束教学周",
  weeks: "指定教学周",
  termStart: "第一教学周周一",
  startTime: "开始时刻",
  endTime: "结束时刻",
  weekday: "星期",
  parity: "单双周",
  goalId: "关联目标",
  taskId: "关联任务",
  reminders: "提醒",
  priority: "优先级",
  targetDate: "目标日期",
  cancelled: "停课",
  replacement: "调课",
  originalDate: "原上课日",
  completed: "时段完成",
  text: "偏好文字",
  enabled: "启用",
  conditions: "额外条件",
  uncertainties: "待确认信息",
  benefitKind: "收益依据",
  kind: "类型",
  courseId: "关联课程",
  candidateId: "关联候选",
  sourceIds: "来源记录",
  sourceQuote: "原文引用",
  temporalEvidence: "时间依据",
  snoozedUntil: "稍后查看时间",
  duplicateOfId: "重复关联",
  revisionOfId: "修订关联",
  decision: "决定",
  reason: "原因",
};
// Only storage metadata is omitted. New business fields must remain reviewable.
const internalFields = new Set(["id", "version", "createdAt", "updatedAt", "recurrence"]);
const values: Record<string, string> = {
  open: "待完成",
  done: "已完成",
  active: "进行中",
  paused: "暂停",
  completed: "已完成",
  all: "每周",
  odd: "单周",
  even: "双周",
  high: "高",
  medium: "普通",
  low: "低",
  pending: "待判断",
  accepted: "已接受",
  ignored: "已忽略",
  stated: "原文明确",
  inferred: "推测",
  unknown: "未知",
  work: "执行时段",
  event: "固定活动",
};
function format(value: unknown): string {
  if (value === null || value === undefined) return "未设置";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string")
    return (
      values[value] ?? (value.includes("T") ? displayInstant(value) : value)
    );
  if (Array.isArray(value)) return value.length ? value.map(format).join("、") : "无";
  if (typeof value === "object") {
    return Object.entries(value)
      .map(
        ([k, v]) =>
          `${({ date: "日期", time: "时刻", enabled: "启用", leadMinutes: "提前分钟", dateOnlyTime: "仅日期提醒时刻", start: "开始", end: "结束", title: "名称", location: "地点" } as Record<string, string>)[k] ?? k}：${format(v)}`,
      )
      .join("；");
  }
  return String(value);
}
function differences(before: Entity | null, after: Entity | null) {
  const a = (before ?? {}) as Record<string, unknown>,
    b = (after ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(
      (k) =>
        !internalFields.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
    )
    .map((k) => ({ key: k, before: format(a[k]), after: format(b[k]) }));
}
function ActivityArrangement({ block }: { block: Block }) {
  const reminder = block.reminders;
  return <>
    <strong>{block.title}</strong>
    <p>{displayInstant(block.start)} – {displayInstant(effectiveActivityEnd(block.start, block.end))}{!block.end && ' · 默认30分钟'}</p>
    <p>地点 · {block.location || '未设置'}</p>
    <p>提醒 · {!reminder.enabled ? '关闭' : reminder.leadMinutes === null ? '按全局设置' : reminder.leadMinutes.length === 0 ? '不设提前提醒' : reminder.leadMinutes.map(minutes => minutes === 0 ? '准时' : `提前${minutes}分钟`).join('、')}{reminder.enabled && reminder.dateOnlyTime ? `；仅日期事项 ${reminder.dateOnlyTime}` : ''}</p>
  </>;
}
export function Preview({
  value,
  confirm,
  cancel,
  busy,
}: {
  value: Extract<MutationResult, { status: "preview" }>;
  confirm: () => void;
  cancel: () => void;
  busy: boolean;
}) {
  const recurring = value.proposedRequest.mutations.length === 1 &&
    ['scheduleRecurringTask', 'createRecurringTask'].includes(value.proposedRequest.mutations[0]!.type);
  const occurrences = recurring ? value.details.filter(d => d.entity === 'block' && !d.before && d.after && 'start' in d.after) : [];
  const seriesMutation = value.proposedRequest.mutations.length === 1 &&
    ['updateRecurringEvent', 'cancelRecurringEvent'].includes(value.proposedRequest.mutations[0]!.type)
    ? value.proposedRequest.mutations[0] : undefined;
  const seriesChanges = seriesMutation ? value.details.filter(d => d.entity === 'block' && d.before && d.after && 'start' in d.before && 'start' in d.after) : [];
  const cancelling = seriesMutation?.type === 'cancelRecurringEvent';
  const occurrenceIds = new Set([...occurrences, ...seriesChanges].map(d => d.id));
  return (
    <div className="preview-content">
      <p className="warning">
        <strong>尚未执行 · 请确认更改</strong>
        <br />
        {value.message}
      </p>
      {value.conflicts.map((c, i) => (
        <div className="conflict" key={i}>
          <strong>{c.kind === "time" ? "时间重叠" : "需要确认"}</strong>
          <p>{c.message}</p>
          {c.conflictingIds.length > 0 && (
            <small>关联记录：{c.conflictingIds.join("、")}</small>
          )}
        </div>
      ))}
      {seriesChanges.length > 0 && <section className="preview-detail" aria-label="重复活动更改清单">
        <h3>{cancelling ? '取消' : '修改'} {seriesChanges.length} 次活动 · {'scope' in seriesMutation! && seriesMutation.scope === 'single' ? '仅本次' : '本次及以后'}</h3>
        <p>{cancelling ? '以下活动将从日历和提醒中取消，关联任务与历史记录保留。' : '以下列出每次活动的当前安排和确认后的安排。'}可通过撤销恢复。</p>
        <table>
          <thead><tr><th>当前安排</th><th>{cancelling ? '确认后' : '修改后'}</th></tr></thead>
          <tbody>{seriesChanges.map(d => <tr key={d.id}>
            <td><ActivityArrangement block={d.before as Block} /></td>
            <td>{cancelling ? <strong>已取消 · 不再提醒</strong> : <ActivityArrangement block={d.after as Block} />}</td>
          </tr>)}</tbody>
        </table>
      </section>}
      {occurrences.length > 0 && <section className="preview-detail" aria-label="重复活动日期清单">
        <h3>{occurrences.length} 次固定活动 · {occurrences[0]!.after && 'title' in occurrences[0]!.after ? occurrences[0]!.after.title : ''}</h3>
        <p>以下每次活动都会加入日历，并关联同一任务。</p>
        <table>
          <thead><tr><th>开始</th><th>结束</th><th>地点</th><th>提醒</th></tr></thead>
          <tbody>{occurrences.map(d => {
            const block = d.after!;
            if (!('start' in block) || !('reminders' in block)) return null;
            return <tr key={d.id}><td>{displayInstant(block.start)}</td><td>{block.end ? displayInstant(block.end) : '默认30分钟'}</td><td>{block.location || '未设置'}</td><td>{format(block.reminders)}</td></tr>;
          })}</tbody>
        </table>
      </section>}
      {value.details.filter(d => !occurrenceIds.has(d.id)).map((d, i) => (
        <section className="preview-detail" key={i}>
          <h3>
            {d.before ? (d.after ? "修改" : "删除") : "新建"}
            {entityNames[d.entity]} ·{" "}
            {value.changes.find((c) => c.id === d.id)?.title ??
              String(
                ((d.after ?? d.before) as unknown as Record<string, unknown>)?.[
                  "title"
                ] ?? "",
              )}
          </h3>
          <table>
            <thead>
              <tr>
                <th>字段</th>
                <th>当前</th>
                <th>确认后</th>
              </tr>
            </thead>
            <tbody>
              {differences(d.before, d.after).map((row) => (
                <tr key={row.key}>
                  <th scope="row">{labels[row.key] ?? row.key}</th>
                  <td>{row.before}</td>
                  <td>{row.after}</td>
                </tr>
              ))}
              {differences(d.before, d.after).length === 0 && (
                <tr><td colSpan={3}>业务字段未改变（仅内部记录信息变化）</td></tr>
              )}
            </tbody>
          </table>
        </section>
      ))}
      <p className="fine-print">
        预览有效至 {displayInstant(value.expiresAt)}
        。确认仅授权这里列出的确切变更。
      </p>
      <footer className="form-footer">
        <button onClick={cancel}>取消更改</button>
        <button className="primary" onClick={confirm} disabled={busy}>
          确认执行
        </button>
      </footer>
    </div>
  );
}
