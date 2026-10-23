import { InstantSchema, addCalendarDays, toShanghaiInstant, type CollectReminders, type Reminder, type ReminderConfig } from '../shared/contracts';
import { instantAt } from './time';
import { expandCourse } from './courses';
/** Scheduled points are (previousCheck, now], and strictly after creation. Pending candidates never emit OS reminders. */
export const collectReminders: CollectReminders = (snapshot, previousCheck, now) => {
  InstantSchema.parse(previousCheck); InstantSchema.parse(now); if (Date.parse(previousCheck) > Date.parse(now)) throw Error('提醒范围无效');
  const out: Reminder[] = []; const s = snapshot.settings; if (!s.remindersEnabled) return out;
  function add(refId: string, refKind: Reminder['refKind'], title: string, dueAt: string, createdAt: string, config: ReminderConfig, leads: number[], dateOnly = false) {
    if (!config.enabled || config.leadMinutes?.length === 0) return;
    for (const lead of new Set(dateOnly ? [0] : config.leadMinutes ?? leads)) {
      const scheduledAt = instantAt(Date.parse(dueAt) - lead * 60000);
      if (Date.parse(scheduledAt) <= Date.parse(previousCheck) || Date.parse(scheduledAt) > Date.parse(now) || Date.parse(scheduledAt) <= Date.parse(createdAt)) continue;
      out.push({ id: `${refKind}:${refId}:${dueAt}:${scheduledAt}`, refId, refKind, title, dueAt, scheduledAt, dateOnly, message: dateOnly ? '今日截止，原文未提供具体截止时刻' : '即将到期或开始' });
    }
  }
  for (const t of snapshot.tasks) if (t.status === 'open' && t.deadline) add(t.id, 'task', t.title, toShanghaiInstant(t.deadline.date, t.deadline.time ?? t.reminders.dateOnlyTime ?? s.dateOnlyReminderTime), t.createdAt, t.reminders, s.taskLeadMinutes, t.deadline.time === null);
  for (const b of snapshot.blocks) if (!b.completed && !b.cancelled) add(b.id, 'block', b.title, b.start, b.createdAt, b.reminders, s.blockLeadMinutes);
  if (s.courseReminders) for (const c of snapshot.courses) {
    const maxLead = Math.max(0, ...(c.reminders.leadMinutes ?? s.courseLeadMinutes));
    for (const item of expandCourse(c, snapshot.courseExceptions, previousCheck.slice(0, 10), addCalendarDays(now.slice(0, 10), Math.ceil(maxLead / 1440)))) add(c.id, 'course', item.title, item.start!, c.createdAt, c.reminders, s.courseLeadMinutes);
  }
  return out.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt) || a.id.localeCompare(b.id));
};
/** Desktop can show one digest instead of one notification per missed reminder. */
export function reminderDigest(reminders: Reminder[]): string { return reminders.length ? `${reminders.length} 条提醒：${[...new Set(reminders.map(r => r.title))].join('、')}` : ''; }
