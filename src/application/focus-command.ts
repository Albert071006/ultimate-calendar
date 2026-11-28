import { FocusSessionInputSchema, addCalendarDays, type CommandRequest, type CommandResult, type FocusAction,
  type FocusCommand, type FocusSession, type FocusMutation, type Snapshot } from '../shared/contracts';
import { pendingClarificationHistory } from '../shared/command-continuation';
import { evidenceDate, evidenceTimes } from '../domain/temporal-evidence';
import { createFocusBelongingResolver, summarizeFocusSessions } from '../domain/focus';
import { instantAt } from '../domain/time';

type Outcome = { result: CommandResult } | { mutation: FocusMutation };
type Links = { courseId?: string; goalId?: string; blockId?: string; taskId?: string };
const digits = '零一二三四五六七八九';
function numeral(word: string): number {
  if (/^\d/.test(word)) return Number(word);
  if (word === '半') return 0.5;
  const x = word.replaceAll('两', '二');
  if (x.includes('百')) { const [a,b] = x.split('百'); return numeral(a!) * 100 + (b ? numeral(b.replace(/^零/, '') || '零') : 0); }
  if (x.includes('十')) { const [a,b] = x.split('十'); return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0); }
  return digits.indexOf(x);
}
/** Only a contiguous duration, such as 一小时二十分钟, supplies seconds for a write. */
function duration(text: string): number | undefined {
  const normalized = text.replace(/(\d+|[一二两三四五六七八九十]+)个半(?:小时|钟头)/g, (_, hours: string) => (numeral(hours) + 0.5) + '小时');
  const parts = [...normalized.matchAll(/(\d+(?:\.\d+)?|[半零一二两三四五六七八九十百]+)\s*(?:个)?\s*(小时|钟头|分钟|秒钟?)/g)];
  if (!parts.length || parts.some((p,i) => i > 0 && normalized.slice(parts[i-1]!.index! + parts[i-1]![0].length, p.index).trim())) return undefined;
  return parts.reduce((n,p) => n + numeral(p[1]!) * (p[2] === '小时' || p[2] === '钟头' ? 3600 : p[2] === '分钟' ? 60 : 1), 0);
}
function span(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return [h && h + ' 小时', m && m + ' 分钟', s && s + ' 秒'].filter(Boolean).join(' ') || '0 分钟';
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replaceAll('高等数学', '高数');
const includes = (text: string, phrase: string) => norm(text).includes(norm(phrase));
function names(snapshot: Snapshot) {
  return [
    ...snapshot.courses.map(({ id, title }) => ({ key: 'courseId' as const, id, title })),
    ...snapshot.goals.map(({ id, title }) => ({ key: 'goalId' as const, id, title })),
    ...snapshot.tasks.map(({ id, title }) => ({ key: 'taskId' as const, id, title })),
    ...snapshot.blocks.filter(r => r.kind === 'work' && !r.cancelled).map(({ id, title }) => ({ key: 'blockId' as const, id, title })),
  ];
}
function links(snapshot: Snapshot, text: string, subject: string | undefined, selected: CommandRequest['selected']): Links | string {
  const rows = names(snapshot);
  if (subject && !includes(text, subject)) return '要关联哪项任务、时段、课程或目标？';
  const hits = subject ? rows.filter(r => includes(r.title, subject)) : rows.filter(r => includes(text, r.title));
  const kinds = { courseId: '课程', goalId: '目标', taskId: '任务', blockId: '时段' } as const;
  const requestedKind = subject && (Object.keys(kinds) as (keyof Links)[]).find(key =>
    includes(text, kinds[key] + subject) || includes(text, subject + kinds[key]));
  const scopedHits = requestedKind ? hits.filter(r => r.key === requestedKind) : hits;
  const exact = subject ? scopedHits.filter(r => norm(r.title) === norm(subject)) : scopedHits;
  const matches = exact.length ? exact : scopedHits;
  const result: Links = {};
  const demonstratives = { taskId: /这(?:个|项)?任务/, blockId: /这(?:个|段)?(?:执行)?时段/, courseId: /这(?:门|个)?课/, goalId: /这(?:个|项)?目标/ };
  for (const key of ['blockId','taskId','courseId','goalId'] as const) {
    let found = matches.filter(r => r.key === key);
    const chosen = selected?.find(r => r.entity + 'Id' === key);
    if (chosen && (found.some(r => r.id === chosen.id) || demonstratives[key].test(text))) found = rows.filter(r => r.key === key && r.id === chosen.id);
    if (!found.length && demonstratives[key].test(text)) return '请选中要关联的事项，或说出完整名称。';
    if (found.length > 1) return '有多项同名或相似的关联，请补充完整名称或选中具体事项。';
    if (found[0]) result[key] = found[0].id;
  }
  if (result.courseId && result.goalId && !/课程.*目标|目标.*课程/.test(text)
      && matches.some(course => course.id === result.courseId && matches.some(goal => goal.id === result.goalId && norm(goal.title) === norm(course.title)))) {
    return '同名课程和目标都存在，请明确要关联的类型和名称。';
  }
  if (subject && !Object.keys(result).length) return '没有找到「' + subject + '」对应的关联，请核对名称。';
  const block = snapshot.blocks.find(b => b.id === result.blockId);
  if (block?.taskId && result.taskId && block.taskId !== result.taskId) return '任务和时段指向不同事项，请指定其中一项。';
  if (block?.taskId) result.taskId = block.taskId;
  const task = snapshot.tasks.find(t => t.id === result.taskId);
  if (task?.courseId) result.courseId ??= task.courseId;
  if (task?.goalId) result.goalId ??= task.goalId;
  return result;
}

function dayIn(text: string, now: string) {
  if (text.includes('前天')) return addCalendarDays(now.slice(0,10), -2);
  return evidenceDate(text, now);
}
function interval(text: string, now: string) {
  const clocks = evidenceTimes(text, true), seconds = duration(text);
  if (seconds === undefined && /分钟|小时|钟头|秒钟/.test(text)) return null;
  const day = dayIn(text, now);
  let start: number, end: number;
  if (!clocks.length && /刚刚|刚才|刚结束|刚完成/.test(text) && seconds !== undefined) {
    if (day && day !== now.slice(0, 10)) return null;
    end = Date.parse(now); start = end - seconds * 1000;
  } else {
    if (clocks.length === 2 && !/到|至|[~～—–-]|开始.*结束/s.test(text)) return null;
    if (!day || clocks.length < 1 || clocks.length > 2 || (clocks.length === 1 && seconds === undefined)) return null;
    start = Date.parse(day + 'T' + clocks[0] + ':00+08:00');
    if (clocks[1]) end = Date.parse((/次日|翌日/.test(text) ? addCalendarDays(day, 1) : day) + 'T' + clocks[1] + ':00+08:00');
    else if (/(?:结束|截止)/.test(text) && !/(?:开始|从)/.test(text)) { end = start; start -= seconds! * 1000; }
    else end = start + seconds! * 1000;
  }
  const active = seconds ?? (end - start) / 1000;
  if (!Number.isInteger(active) || active < 60 || active > 86400 || end > Date.parse(now) || end - start < active * 1000) return null;
  return { start: instantAt(start), end: instantAt(end), durationSeconds: active };
}
function mentionedTitle(text: string, snapshot: Snapshot) {
  const records = [...snapshot.courses, ...snapshot.goals, ...snapshot.tasks, ...snapshot.blocks, ...snapshot.focusSessions];
  return records.reduce<string | undefined>((best, { title }) =>
    includes(text, title) && title.length > (best?.length ?? 0) ? title : best, undefined);
}

function subjectMatcher(snapshot: Snapshot, subject: string) {
  const taskIds = new Set(snapshot.tasks.filter(t => includes(t.title, subject)).map(t => t.id));
  const blockIds = new Set(snapshot.blocks.filter(b => includes(b.title, subject) || b.taskId && taskIds.has(b.taskId)).map(b => b.id));
  return (s: FocusSession, belongingName: string) => includes(s.title, subject) || includes(belongingName, subject)
    || !!s.taskId && taskIds.has(s.taskId) || !!s.blockId && blockIds.has(s.blockId);
}
/** A plain model reply must never supply numbers for a recognizable focus question. */
export function explicitFocusQuestion(text: string, snapshot: () => Snapshot): 'query' | 'status' | undefined {
  if (/日历|提醒|计划|预计|安排|开会|价钱|多少钱|消费|付款|如何|怎么用|设置|如果|假如|修改|改成|删除|删掉|补记|补录/.test(text)) return;
  if (/(?:现在|当前|正在).*(?:专注|计时|番茄).*(?:多久|多长|多少|状态|几分钟)|(?:计时器|番茄钟).*(?:现在|当前).*状态/.test(text)) return 'status';
  if (/(?:专注|完成.{0,4}番茄).*(?:多久|多长|几分钟|多少|几次)|完成(?:了)?(?:几|多少)(?:个)?番茄|(?:查|看|列出|统计).*(?:专注记录|专注投入|专注时间)/.test(text)) return 'query';
  if (/花了多少(?:个)?(?:小时|分钟)/.test(text) && (/学习|课程|目标|高数|专注/.test(text) || mentionedTitle(text, snapshot()))) return 'query';
}
function focusQuestion(text: string, snapshot: Snapshot, proposed: Extract<FocusCommand,{type:'query'}>): Extract<FocusCommand,{type:'query'}> {
  const period = /(?:本|上|这)(?:个)?月/.test(text) ? 'month' : /(?:本|上|这)(?:个)?(?:周|星期)/.test(text) ? 'week' : /今天|昨天|前天/.test(text) ? 'day' : proposed.period;
  const view = /各[门个项]|分别|分布|占比/.test(text) ? 'distribution' : /明细|记录/.test(text) ? 'records' : proposed.view;
  const timeSpentOn = text.match(/(?:今天|昨天|前天|(?:本|上|这)(?:个)?(?:周|星期|月))(?:我)?(?:在)?([^，。？！?\n]{1,60}?)(?:上)?花了多少(?:个)?(?:小时|分钟)/)?.[1]?.trim();
  const scopeText = text.replace(/专注记录|专注时间|专注投入|专注|番茄(?:钟)?|本月|本周|今天|昨天|前天|完成了?|多久|多少小时|多少分钟/g, ' ');
  const subject = proposed.subject ?? mentionedTitle(scopeText, snapshot) ?? timeSpentOn;
  return { ...proposed, type:'query', period, view, subject };
}
function query(command: Extract<FocusCommand,{type:'query'}>, text: string, snapshot: Snapshot, now: string) {
  const { period, view, subject } = command;
  const today = now.slice(0, 10);
  const relativePeriod = /(?:上|本|这)个?(?:周|星期|月)/.test(text);
  let date = dayIn(text, now) ?? (relativePeriod ? today : command.date ?? today);
  if (/上个?(?:周|星期)/.test(text)) date = addCalendarDays(today, -7);
  if (/上个?月/.test(text)) date = addCalendarDays(today.slice(0, 7) + '-01', -1);
  let data = summarizeFocusSessions(snapshot.focusSessions, snapshot, { period, date });
  if (subject) {
    const groups = new Set([...snapshot.courses, ...snapshot.goals].filter(v => norm(v.title) === norm(subject)).map(v => v.id));
    const matches = subjectMatcher(snapshot, subject);
    const selected = data.details.flatMap(day => day.entries.filter(({ session, belonging }) =>
      groups.size ? belonging.id !== null && groups.has(belonging.id) : matches(session, belonging.name)).map(row => row.session));
    data = summarizeFocusSessions(selected, snapshot, { period, date });
  }
  const range = data.from === data.to ? data.from : data.from + ' 至 ' + data.to;
  const head = range + (subject ? '「' + subject + '」' : '') + '共专注 ' + span(data.totalSeconds) + '，' + data.sessionCount + ' 条记录，完成 ' + data.completedPomodoros + ' 个番茄。';
  if (view === 'distribution') return [head, ...data.byBelonging.map(b => b.name + ' · ' + span(b.durationSeconds) + '（' + Math.round(100*b.share) + '%）')].join('\n');
  if (view === 'records') {
    const rows = data.details.flatMap(d => d.entries.map(({session:s, belonging}) => d.date + ' ' + s.start.slice(11,16) + '–' + s.end.slice(11,16) + ' ' + s.title + ' · ' + span(s.durationSeconds) + ' · ' + belonging.name));
    return [head, ...rows.slice(0,50), ...(rows.length > 50 ? ['以上为最近 50 条，其余可在专注统计中查看。'] : [])].join('\n');
  }
  return head;
}

export function prepareFocusCommand(command: FocusCommand, request: CommandRequest, snapshot: Snapshot, now: string): Outcome {
  const domain = request.focusTimer === undefined ? 'calendar' : 'focus';
  const answer = (reply: string, phase: 'query' | 'clarification' = 'query', focusAction?: FocusAction): Outcome =>
    ({ result: { reply, mutationResult: null, items: [], conversationState: { domain, phase }, ...(focusAction && { focusAction }) } });
  const ask = (message: string) => answer(message, 'clarification');
  // Only user messages from the contiguous, unfinished focus exchange may supply missing facts.
  const chain = pendingClarificationHistory(request);
  const boundary = chain.findLastIndex(turn => turn.role === 'assistant' && turn.outcome?.domain !== 'focus');
  const pending = chain.slice(boundary + 1);
  const continuing = pending.at(-1)?.outcome?.domain === 'focus';
  const text = (continuing ? [...pending.filter(e => e.role === 'user').map(e => e.text), request.text] : [request.text]).join('\n').trim();
  if (command.type === 'clarification') return ask(command.question);
  if (command.type === 'query') {
    const scoped = focusQuestion(text, snapshot, command);
    return scoped.subject && !includes(text, scoped.subject) ? ask('要查询哪门课程或哪个目标？') : answer(query(scoped, text, snapshot, now));
  }
  const timer = request.focusTimer;
  if (command.type === 'status') {
    if (timer === undefined) return answer('此客户端没有提供本机计时状态。');
    if (!timer) return answer('本机当前没有进行中的专注。');
    const phase = { running:'专注中', paused:'已暂停', settlement:'待结算', breakGuide:'等待开始休息', breakRunning:'休息中', breakPaused:'休息已暂停', breakEnded:'休息已结束' }[timer.phase];
    return answer('「' + timer.title + '」' + phase + '，' + (timer.phase.startsWith('break') ? '本段休息 ' : '有效专注 ') + span(Math.floor(timer.elapsedMs / 1000)) + '。');
  }
  if (continuing && /^(?:好(?:的)?|嗯|是(?:的)?|谢谢|知道了)[。！!\s]*$/.test(request.text.trim())) return ask('请补充上条追问中的具体信息。');
  if (!request.text.trim() || /只查|只看|别动|先不|不要|不(?:开|启|记|改|删|启动|修改|需要)|别(?:开|启|记|改|删|暂停|结束)|不用|取消请求|如果|假如|怎么(?:开|记|改|删)|如何|算了|有没有|是否已经|是否已|是不是已经/.test(request.text)) return ask('请确认这次希望执行的专注操作。');
  if (command.type === 'start' || command.type === 'pause' || command.type === 'resume' || command.type === 'finish') {
    if (timer === undefined) return answer('请在支持专注计时的客户端打开计时面板。');
    const verbs = {
      start: /(?:开(?:始|启)?|启动|来|设|定).{0,32}(?:番茄|专注|秒表|计时)|(?:番茄|专注|秒表|计时).{0,10}(?:启动|开始)|(?:帮我|给我|现在)(?:正向)?计时/,
      pause: /暂停|停一下/, resume: /继续|恢复/, finish: /结束|停止|收工/,
    };
    if (/打开.{0,10}(?:统计|面板|页面)|提醒|明天|下周|预约|买|费用/.test(request.text)) return ask('是要现在操作本机计时器吗？');
    if (command.type !== 'start' && !/番茄|计时|秒表|专注|休息/.test(text)) return ask('是要控制本机专注计时吗？');
    if (!verbs[command.type].test(text)) return ask('希望开始、暂停、继续还是结束计时？');
    if (command.type !== 'start') {
      if (!timer) return answer('本机当前没有计时。');
      return answer('已收到本机计时请求。', 'query', { type: command.type, ...(timer.timerId && {timerId:timer.timerId}) });
    }
    const wantsStopwatch = /正向|正计时|秒表/.test(text);
    const wantsPomodoro = /番茄|倒计时/.test(text);
    if (wantsStopwatch && wantsPomodoro) return ask('这次要开番茄倒计时还是正向计时？');
    const mode = wantsStopwatch ? 'stopwatch' : wantsPomodoro ? 'pomodoro' : command.mode;
    const related = links(snapshot, text, command.subject, request.selected);
    if (typeof related === 'string') return ask(related);
    const seconds = duration(text), minutes = seconds === undefined ? undefined : seconds / 60;
    if (seconds === undefined && /分钟|小时|钟头|秒钟/.test(text)) return ask('这次番茄的目标是多少分钟？');
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 480 || mode === 'stopwatch')) return ask('请指定 1 至 480 的整数目标分钟数，或选择正向计时。');
    const title = (command.title && includes(text, command.title) ? command.title : undefined)
      ?? names(snapshot).find(r => related[r.key] === r.id)?.title ?? command.subject ?? '自由专注';
    return answer('已收到本机计时请求。', 'query', { type:'start', title, mode, ...(minutes !== undefined && { plannedMinutes: minutes }), ...related });
  }
  if (command.type === 'create') {
    const backfill = /补(?:记|录|登)|记(?:下|一?笔|一下|上)|登记|(?:^|[，,。\n]|帮我|给我|请|麻烦)记录|^记(?:今天|昨天|刚才|刚刚)/;
    if (!backfill.test(text) || /删除|删掉|修改|改成|改为|多久|多少(?:分钟|小时)|几(?:个)?番茄|看看|查看|查询|列出/.test(request.text)) return ask('要补录哪次专注？请说明内容、开始或结束时间及有效时长。');
    const times = interval(text, now);
    if (!times || !includes(text,command.title)) return ask('请补充专注内容、具体起止时间或刚刚结束的有效时长，至少 1 分钟。');
    const related = links(snapshot, text, command.subject, request.selected);
    if (typeof related === 'string') return ask(related);
    return { mutation: { type:'createFocusSession', values: FocusSessionInputSchema.parse({title:command.title, mode:'manual', ...times, ...related}) } };
  }
  if (command.type !== 'delete' && command.type !== 'update') return ask('请说明要处理的专注记录。');
  const edit = prepareHistoricalChange(command, request, snapshot, now, text, continuing);
  return typeof edit === 'string' ? ask(edit) : { mutation: edit };
}

function prepareHistoricalChange(command: Extract<FocusCommand, { type: 'delete' | 'update' }>, request: CommandRequest,
  snapshot: Snapshot, now: string, text: string, continuing: boolean): FocusMutation | string {
  const deleting = command.type === 'delete';
  if (!(deleting ? /删除|删掉|删去|移除/ : /修改|改成|改为|改到|改一下|更正|改名|改回|调整/).test(text)) return '希望如何修改这条专注记录？';
  const [original = '', changeText = ''] = deleting ? [text] : text.split(/修改为|改名为|改成|改为|改到|改回|更正为|调整为/);
  const targetAnswer = continuing && changeText.includes('\n') && /那(?:个|条|次)|这(?:个|条|次)|开始的|^\s*\d{1,2}[:：]\d{2}\s*$/.test(request.text);
  const selector = targetAnswer ? original + '\n' + request.text : original;
  const replacement = targetAnswer ? changeText.slice(0, changeText.lastIndexOf('\n')) : changeText;
  const match = command.match ?? mentionedTitle(selector, snapshot);
  const day = dayIn(selector, now), clocks = evidenceTimes(selector, true);
  if (!day && !match && !/刚才|最近|上一条|最后一条/.test(selector)) return '要处理哪天、什么内容的专注记录？';
  if (command.match && !includes(selector, command.match)) return '请补充原记录的日期、标题或归属。';
  const matches = match && subjectMatcher(snapshot, match);
  const resolveBelonging = createFocusBelongingResolver(snapshot);
  let candidates = snapshot.focusSessions.filter(s => {
    const hour = Number(s.start.slice(11,13));
    return (!day || s.start.startsWith(day)) && (!matches || matches(s, resolveBelonging(s).name))
      && (!clocks.length || clocks.includes(s.start.slice(11,16)))
      && (!/下午/.test(selector) || hour >= 12 && hour < 19) && (!/上午|早上/.test(selector) || hour < 12)
      && (!/晚上/.test(selector) || hour >= 18);
  }).sort((a,b) => Date.parse(b.end) - Date.parse(a.end));
  if (/刚才/.test(selector)) candidates = candidates.filter(s => Date.parse(now) >= Date.parse(s.end) && Date.parse(now) - Date.parse(s.end) <= 3600000);
  if (/上一条|最后一条|最近一条/.test(selector) && candidates.length) candidates = candidates.filter(s => s.end === candidates[0]!.end);
  if (!candidates.length) return '没有找到这条专注记录，请核对日期、标题或开始时间。';
  if (candidates.length > 1) {
    const choices = candidates.slice(0, 6).map(s => s.start.slice(0, 16).replace('T', ' ') + ' ' + s.title);
    return ['匹配到多条专注，请指定日期和开始时间', ...choices].join('\n');
  }
  const s = candidates[0]!;
  if (command.type === 'delete') return { type: 'deleteFocusSession', id: s.id, expectedVersion: s.version };
  const values: Extract<FocusMutation,{type:'updateFocusSession'}>['values'] = {};
  const newClocks = evidenceTimes(replacement, true);
  const seconds = duration(replacement || request.text);
  if (newClocks.length) {
    const date = dayIn(replacement, now) ?? s.start.slice(0,10);
    const shiftEnd = newClocks.length === 1 && /结束/.test(original);
    const oldSpan = Date.parse(s.end) - Date.parse(s.start);
    const start = shiftEnd ? Date.parse(s.start) : Date.parse(date + 'T' + newClocks[0] + ':00+08:00');
    const endClock = shiftEnd ? newClocks[0] : newClocks[1];
    const end = endClock ? Date.parse(date + 'T' + endClock + ':00+08:00') : start + oldSpan;
    const pausedMs = Math.max(0, oldSpan - s.durationSeconds * 1000);
    values.start = instantAt(start); values.end = instantAt(end);
    values.durationSeconds = seconds ?? Math.floor((end - start - pausedMs) / 1000);
  }
  if (seconds !== undefined) {
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) return '有效时长须为 1 分钟到 24 小时。';
    values.durationSeconds = seconds;
    if (!newClocks.length && Date.parse(s.end) - Date.parse(s.start) < seconds*1000) values.end = instantAt(Date.parse(s.start) + seconds*1000);
  }
  if (s.mode === 'pomodoro' && values.durationSeconds !== undefined && values.durationSeconds < s.plannedMinutes!*60) values.completedTarget = false;
  if (command.title && includes(text,command.title)) values.title = command.title;
  if (command.note !== undefined && (command.note ? text.includes(command.note) : /清空备注|删除备注/.test(text))) values.note = command.note;
  if (command.subject) {
    const related = links(snapshot, replacement || request.text, command.subject, request.selected);
    if (typeof related === 'string') return related;
    Object.assign(values, { taskId:null, blockId:null, courseId:null, goalId:null }, related);
  }
  if (!Object.keys(values).length) return '请说明新的有效时长、标题、归属或备注。';
  const { id: _id, version: _version, createdAt: _created, updatedAt: _updated, ...before } = s;
  if (!FocusSessionInputSchema.safeParse({ ...before, ...values }).success || Date.parse(values.end ?? s.end) > Date.parse(now)) return '请核对新的起止时间与有效时长。';
  return { type: 'updateFocusSession', id: s.id, expectedVersion: s.version, values };
}
