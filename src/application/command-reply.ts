import type { MutationResult, Snapshot } from '../shared/contracts';

/** The committed result, rather than a model's pre-execution guess, says what saved. */
export function commandMutationReply(result: MutationResult, snapshot: Snapshot): string {
  if (result.status !== 'applied') return result.message;
  const changedBlocks = snapshot.blocks.filter(block => result.changes.some(change => change.entity === 'block' && change.id === block.id && change.action !== 'delete'));
  const scheduledTasks = new Set(changedBlocks.flatMap(block => block.taskId ? [block.taskId] : []));
  const lines = result.changes.flatMap(change => {
    if (change.entity === 'task' && change.action === 'create' && scheduledTasks.has(change.id)) return [];
    const verb = change.action === 'create' ? '已新增' : change.action === 'delete' ? '已移除' : '已更新';
    const block = changedBlocks.find(record => record.id === change.id);
    if (block) {
      const start = block.start.slice(0, 16).replace('T', ' ');
      const end = block.end ? block.end.slice(block.end.slice(0, 10) === block.start.slice(0, 10) ? 11 : 0, 16).replace('T', ' ') : '';
      const reminder = !block.completed && !block.cancelled && block.reminders.enabled && block.reminders.leadMinutes?.includes(0) ? '，准时提醒' : '';
      const blockVerb = block.cancelled ? '已取消' : block.completed ? '已完成' : verb;
      return [`${blockVerb}日历安排：${block.title}，${start}${end ? `–${end}` : ''}${reminder}。`];
    }
    const task = change.entity === 'task' ? snapshot.tasks.find(record => record.id === change.id) : undefined;
    const deadline = task?.deadline ? `，截止 ${task.deadline.date}${task.deadline.time ? ` ${task.deadline.time}` : ''}` : '';
    return [`${task?.status === 'done' ? '已完成' : verb}：${change.title}${deadline}。`];
  });
  return [result.message, ...lines.slice(0, 8), ...(lines.length > 8 ? [`另有 ${lines.length - 8} 项更改。`] : [])].join('\n');
}
