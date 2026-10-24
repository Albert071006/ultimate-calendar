import { CommandIntentSchema, type CommandRequest } from '../shared/contracts';
import { evidenceDate, evidenceTimes } from '../domain/temporal-evidence';
import type { z } from 'zod';

type Intent = z.infer<typeof CommandIntentSchema>;

/** A narrow grounding hint, not a second natural-language command parser.
 * The model still decides the action and its target. Only one explicit reminder
 * time in the current user message is grounded here, never imported text/history.
 */
export function explicitReminderStart(text: string, now: string): string | null {
  if (!/(?:提醒我|提醒一下|设(?:置)?(?:个|一个)?提醒)/.test(text)) return null;
  // Preserve real deadlines, recurrence, alternatives and negative instructions.
  if (/截止|最晚|之前|以前|前提醒|到期|ddl|每|隔周|单周|双周|或|还是|不要|不用|取消|删除|不再|别提醒/i.test(text)) return null;
  // evidenceDate intentionally prefers a complete date in source evidence. A
  // command may mention an activity date AND a different reminder date, so that
  // preference cannot authorize overriding the model's semantic interpretation.
  const dateReferences = text.match(/(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}(?:日|号)?|\d{1,2}(?:日|号)|大后天|后天|明天|今天|昨天|前天|今晚|明晚|今早|明早|(?:上上|下下|上|下|本|这)?(?:周|星期|礼拜)[一二三四五六日天末]|[今明后去前]年|[上下](?:个)?月/g) ?? [];
  if (dateReferences.length !== 1) return null;
  const date = evidenceDate(text, now);
  const allTimes = evidenceTimes(text);
  const times = evidenceTimes(text, true);
  return date && times.length === 1 && allTimes.length === 1 ? `${date}T${times[0]}:00+08:00` : null;
}

/** Correct the former task-deadline-only proposal for a clearly timed reminder.
 * No records are created without the model's single-create mutation, and no
 * pre-existing task or genuine deadline is changed by this compatibility path.
 */
export function groundTimedCommand(intent: Intent, request: CommandRequest, now: string): Intent {
  if (intent.kind !== 'mutate' || intent.mutations.length !== 1) return intent;
  const start = explicitReminderStart(request.text, now);
  if (!start) return intent;
  const mutation = intent.mutations[0]!;
  const reminders = /提前/.test(request.text) ? undefined : { enabled: true, leadMinutes: [0], dateOnlyTime: null };
  if (mutation.type === 'createScheduledTask') {
    // A null end is the explicit 30-minute default; do not shift an independently
    // supplied end or erase a separate deadline.
    if (mutation.end !== null) return intent;
    return { ...intent, mutations: [{ ...mutation, start, ...(reminders ? { reminders } : {}) }] };
  }
  if (mutation.type !== 'create' || mutation.entity !== 'task' || !mutation.values.deadline?.time) return intent;
  // Explicit durations/ranges are handled by the typed scheduled-task proposal;
  // a deadline-only proposal does not contain enough information to recover them.
  if (/持续|时长|分钟|小时|一刻|三刻/.test(request.text)) return intent;
  return CommandIntentSchema.parse({ ...intent, mutations: [{ type: 'createScheduledTask', values: { ...mutation.values, deadline: null }, start, end: null, reminders: reminders ?? mutation.values.reminders }] });
}
