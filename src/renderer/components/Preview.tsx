import type { Block, Entity, MutationResult } from "../../shared/contracts";
import { effectiveActivityEnd } from '../../domain/activity-duration';
import { displayInstant } from "../calendar-layout";
import { entityNames } from "./detail/records";
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
// Fields that point at another record; the preview names the record instead of showing its id.
const linkFields = new Set(["taskId", "goalId", "courseId", "candidateId", "duplicateOfId", "revisionOfId", "sourceIds"]);
const linkNouns: Record<string, string> = { taskId: "任务", goalId: "目标", courseId: "课程", candidateId: "通知", duplicateOfId: "通知", revisionOfId: "通知", sourceIds: "来源" };
type Lookup = (id: string) => string | undefined;
function format(value: unknown, name?: Lookup): string {
  if (value === null || value === undefined) return "未设置";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string")
    return (
      values[value] ?? name?.(value) ?? (/^\d{4}-\d{2}-\d{2}T/.test(value) ? displayInstant(value) : value)
    );
  if (Array.isArray(value)) return value.length ? value.map(item => format(item, name)).join("、") : "无";
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
function differences(before: Entity | null, after: Entity | null, name?: Lookup) {
  const a = (before ?? {}) as Record<string, unknown>,
    b = (after ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(
      (k) =>
        !internalFields.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
    )
    .map((k) => ({ key: k, before: format(a[k], linkFields.has(k) ? name : undefined), after: format(b[k], linkFields.has(k) ? name : undefined), cleared: b[k] === null || b[k] === undefined }));
}
type Detail = Extract<MutationResult, { status: "preview" }>["details"][number];
const fieldsOf = (entity: Entity | null) => (entity ?? {}) as unknown as Record<string, unknown>;
const titleOf = (detail: Detail) => String(fieldsOf(detail.after ?? detail.before).title ?? "");
/** The word a person would use: notices rather than candidates, sessions vs. activities by kind. */
function noun(detail: Detail) {
  if (detail.entity === "candidate") return "通知";
  if (detail.entity === "block") return fieldsOf(detail.after ?? detail.before).kind === "event" ? "活动" : "时段";
  return entityNames[detail.entity];
}
/** One plain sentence per change; the field-by-field table stays behind 查看具体变更. */
function sentence(detail: Detail, name: Lookup, removed: Set<string>) {
  const title = titleOf(detail), quoted = title ? `「${title}」` : "";
  if (!detail.before) return `新建${noun(detail)}${quoted}`;
  if (!detail.after) {
    const start = fieldsOf(detail.before).start;
    return `${detail.entity === "task" ? "移除" : "删除"}${noun(detail)}${quoted}${typeof start === "string" ? `（${displayInstant(start)}）` : ""}`;
  }
  const rows = differences(detail.before, detail.after, name);
  if (!rows.length) return `更新${noun(detail)}${quoted}的内部记录`;
  if (rows.every(row => linkFields.has(row.key) && row.cleared)) {
    const unlinked = rows.map(row => {
      const id = fieldsOf(detail.before)[row.key];
      return typeof id === "string" && removed.has(id) ? `被移除的${linkNouns[row.key]}` : `${linkNouns[row.key]}「${row.before}」`;
    });
    return `${noun(detail)}${quoted}保留，只是不再关联${unlinked.join("、")}`;
  }
  const shown = rows.slice(0, 3).map(row => `${labels[row.key] ?? row.key} ${row.before} → ${row.after}`);
  return `修改${noun(detail)}${quoted}：${shown.join("；")}${rows.length > 3 ? ` 等 ${rows.length} 项` : ""}`;
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
  names,
}: {
  value: Extract<MutationResult, { status: "preview" }>;
  confirm: () => void;
  cancel: () => void;
  busy: boolean;
  /** Names records the preview itself does not carry, e.g. the course a task links to. */
  names?: Lookup;
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
  const others = value.details.filter(d => !occurrenceIds.has(d.id));
  const inPreview = new Map(value.details.map(d => [d.id, titleOf(d)]));
  const name: Lookup = id => inPreview.get(id) || names?.(id);
  const removed = new Set(value.details.filter(d => d.before && !d.after).map(d => d.id));
  const lines = [
    ...(occurrences.length ? [`新增 ${occurrences.length} 次固定活动`] : []),
    ...(seriesChanges.length ? [`${cancelling ? '取消' : '修改'} ${seriesChanges.length} 次活动`] : []),
    // Removals first, then additions, then edits, so the consequential part reads first.
    ...[...others].sort((a, b) => Number(!!a.after) - Number(!!b.after) || Number(!!a.before) - Number(!!b.before)).map(d => sentence(d, name, removed)),
  ];
  const shownLines = lines.length > 7 ? lines.slice(0, 6) : lines;
  return (
    <div className="preview-content">
      <section className="preview-summary" aria-label="更改摘要">
        <p className="preview-lead">确认后将：</p>
        <ul>
          {shownLines.map((line, i) => <li key={i}>{line}</li>)}
          {shownLines.length < lines.length && <li className="more">还有 {lines.length - shownLines.length} 项，见「查看具体变更」</li>}
        </ul>
        <p className="preview-note">尚未执行 · 确认后可以撤销</p>
      </section>
      {value.conflicts.map((c, i) => (
        <div className="conflict" key={i}>
          <strong>{c.kind === "time" ? "时间重叠" : "需要确认"}</strong>
          <p>{c.message}</p>
          {c.conflictingIds.length > 0 && (
            <small>关联：{c.conflictingIds.map(id => name(id) ?? "另一条记录").join("、")}</small>
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
      {others.length > 0 && <details className="preview-more">
        <summary>查看具体变更</summary>
        {others.map((d, i) => {
          const rows = differences(d.before, d.after, name);
          // A record being created or removed only needs what it holds, not a column of 未设置.
          const whole = !d.before || !d.after;
          const shown = whole ? rows.filter(row => (d.after ? row.after : row.before) !== "未设置") : rows;
          return (
            <section className="preview-detail" key={i}>
              <h3>{d.before ? (d.after ? "修改" : d.entity === "task" ? "移除" : "删除") : "新建"}{noun(d)} · {titleOf(d)}</h3>
              <table>
                <thead><tr><th>字段</th>{whole ? <th>{d.after ? "内容" : "移除的内容"}</th> : <><th>当前</th><th>确认后</th></>}</tr></thead>
                <tbody>
                  {shown.map(row => (
                    <tr key={row.key}>
                      <th scope="row">{labels[row.key] ?? row.key}</th>
                      {whole ? <td>{d.after ? row.after : row.before}</td> : <><td>{row.before}</td><td>{row.after}</td></>}
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={3}>业务字段未改变（仅内部记录信息变化）</td></tr>}
                </tbody>
              </table>
            </section>
          );
        })}
        <p className="fine-print">预览有效至 {displayInstant(value.expiresAt)}。确认仅授权这里列出的确切变更。</p>
      </details>}
      {others.length === 0 && <p className="fine-print">预览有效至 {displayInstant(value.expiresAt)}。确认仅授权这里列出的确切变更。</p>}
      <footer className="form-footer">
        <button onClick={cancel}>取消更改</button>
        <button className="primary" onClick={confirm} disabled={busy}>
          确认执行
        </button>
      </footer>
    </div>
  );
}
