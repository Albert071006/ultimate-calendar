import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanner } from '../domain/planner';
import { createRepository, newEntity, type Repository } from '../storage/repository';
import { createController } from './controller';
import { CommandResultSchema, type CommandRequest, type FocusCommand } from '../shared/contracts';
import { instantAt } from '../domain/time';

const repositories: Repository[] = [];
afterEach(() => { for (const r of repositories.splice(0)) r.close(); });
const now = '2030-05-15T18:00:00+08:00';
function fixture() {
  const repository = createRepository(':memory:', { automaticBackup() {} }); repositories.push(repository);
  const planner = createPlanner(repository, { automaticBackup() {} });
  let output: unknown;
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: {content:JSON.stringify(output)}, finish_reason:'stop' }],
    usage: {prompt_tokens:10, completion_tokens:10, total_tokens:20},
  })));
  const controller = createController({repository, planner, now:() => now, fetch, automaticBackup() {}, getApiKey:async () => 'synthetic'});
  async function send(text: string, command: FocusCommand, extra: Partial<CommandRequest> = {}, generic = false) {
    output = generic ? {kind:'query', reply:'编造的 999 小时'} : {kind:'focus',command};
    const result = await controller.command({operationId:crypto.randomUUID(), text, focusTimer:null, ...extra});
    if (!result.ok) throw Error(result.error.message);
    return CommandResultSchema.parse(result.data);
  }
  function seed(title: string, start: string, durationSeconds: number, extra: object = {}) {
    return repository.transact(state => newEntity(state,'focusSession',{title, mode:'manual', start, end:instantAt(Date.parse(start)+durationSeconds*1000), durationSeconds, ...extra}));
  }
  return {repository, planner, send, seed, fetch};
}
const summary = {type:'query',period:'day',view:'summary'} as const;

describe('grounded focus assistant', () => {
  it('uses Shanghai start dates, effective seconds, effective belonging and completed pomodoros for day/week/month', async () => {
    const f = fixture();
    const ids = f.repository.transact(state => {
      const course = newEntity(state,'course',{title:'高等数学',weekday:1,termStart:'2030-05-06',startTime:'08:00',endTime:'09:00',firstWeek:1,lastWeek:8});
      const goal = newEntity(state,'goal',{title:'练习目标'});
      const task = newEntity(state,'task',{title:'独立习题',courseId:course.id,goalId:goal.id});
      return {taskId:task.id,goalId:goal.id};
    });
    f.seed('跨午夜的练习','2030-05-14T23:59:00+08:00',120,{...ids,mode:'pomodoro',plannedMinutes:2});
    f.seed('清晨练习','2030-05-15T00:01:00+08:00',61,{...ids,end:'2030-05-15T00:10:00+08:00'});
    f.seed('上周练习','2030-05-03T12:00:00+08:00',1800,{goalId:ids.goalId});
    const journal = f.planner.snapshot().journal;
    expect((await f.send('我今天专注了多久，完成几个番茄？',summary,{},true)).reply).toContain('1 分钟 1 秒，1 条记录，完成 0 个番茄');
    expect((await f.send('我这周高数花了多少小时？',{...summary,period:'week',subject:'高数'})).reply).toContain('3 分钟 1 秒，2 条记录，完成 1 个番茄');
    const month = await f.send('这个月各个课程和目标分别专注了多久？',{...summary,period:'month',view:'distribution'});
    expect(month.reply).toContain('高等数学 · 3 分钟 1 秒'); expect(month.reply).toContain('练习目标 · 30 分钟');
    expect((await f.send('本月练习目标专注了多久？',{...summary,subject:'练习目标'})).reply).toContain('30 分钟，1 条记录');
    const yesterday = await f.send('帮我看看昨天的专注记录',{...summary,view:'records'});
    expect(yesterday.reply).toContain('跨午夜的练习'); expect(yesterday.reply).not.toContain('清晨练习');
    expect((await f.send('前天专注了多久？',summary)).reply).toContain('0 条记录');
    expect((await f.send('我这周天文学花了多少小时？',summary)).reply).toContain('「天文学」共专注 0 分钟');
    expect((await f.send('上个月专注了多久？',{...summary,date:'2030-05-15'})).reply).toContain('2030-04-01 至 2030-04-30');
    expect(f.planner.snapshot().journal).toEqual(journal);
  });

  it('creates one grounded manual session, preserves a stable receipt, and supports undo', async () => {
    const f = fixture();
    const task = f.repository.transact(state => newEntity(state,'task',{title:'高数'}));
    const text = '帮我补记刚才写了 40 分钟高数', command = {type:'create',title:'高数'} as const;
    const result = await f.send(text,command,{operationId:'same-command'});
    expect(result.mutationResult?.status).toBe('applied');
    expect(f.planner.snapshot().focusSessions).toMatchObject([{title:'高数', mode:'manual',start:'2030-05-15T17:20:00+08:00',end:now,durationSeconds:2400,taskId:task.id}]);
    expect(await f.send(text,command,{operationId:'same-command'})).toEqual(result); expect(f.fetch).toHaveBeenCalledTimes(1);
    if (result.mutationResult?.status !== 'applied') throw Error('expected applied');
    expect(f.planner.undo(result.mutationResult.transactionId).status).toBe('applied');
    expect(f.planner.snapshot().focusSessions).toHaveLength(0);
    await f.send('记一下今天 14:00 到 14:45 专注做英语阅读',{type:'create',title:'英语阅读'});
    expect(f.planner.snapshot().focusSessions[0]?.durationSeconds).toBe(2700);
  });

  it('clarifies missing or ambiguous facts, previews only the selected edit, and never replays the confirmed edit', async () => {
    const f = fixture(); f.seed('高数','2030-05-15T14:00:00+08:00',600); f.seed('高数','2030-05-15T15:00:00+08:00',600);
    for (const text of ['补记今天高数40分钟','补记刚才高数','补记刚才高数59秒']) {
      expect((await f.send(text,{type:'create',title:'高数'})).conversationState?.phase).toBe('clarification');
    }
    const text = '把今天下午那条高数专注改成50分钟', edit = {type:'update',match:'高数'} as const;
    const question = await f.send(text,edit);
    expect(question.reply).toContain('匹配到多条'); expect(question.reply).toContain('14:00');
    const extra = {operationId:'chosen-edit', history:[{role:'user' as const,text},{role:'assistant' as const,text:question.reply,outcome:question.conversationState}]};
    const preview = (await f.send('14:00那条',edit,extra)).mutationResult;
    if (preview?.status !== 'preview') throw Error('expected edit preview: ' + JSON.stringify(preview));
    expect(f.planner.snapshot().focusSessions.map(s=>s.durationSeconds)).toEqual([600,600]);
    const confirmed = f.planner.mutate({...preview.proposedRequest,origin:'manual',confirmed:true,confirmationToken:preview.confirmationToken});
    expect(confirmed.status).toBe('applied');
    expect((await f.send('14:00那条',edit,extra)).mutationResult).toEqual(confirmed);
    expect(f.planner.snapshot().focusSessions.find(s=>s.start.includes('14:00'))?.durationSeconds).toBe(3000);
    if (confirmed.status === 'applied') f.planner.undo(confirmed.transactionId);
    expect(f.planner.snapshot().focusSessions.map(s=>s.durationSeconds)).toEqual([600,600]);
  });

  it('previews deletion of a recent session, guards its version and restores it on undo', async () => {
    const f = fixture(); f.seed('刚完成的练习','2030-05-15T17:40:00+08:00',900);
    const preview = (await f.send('删掉刚才那条专注记录',{type:'delete'})).mutationResult;
    if (preview?.status !== 'preview') throw Error('expected deletion preview');
    expect(f.planner.snapshot().focusSessions).toHaveLength(1);
    const receipt = f.planner.mutate({...preview.proposedRequest,origin:'manual',confirmed:true,confirmationToken:preview.confirmationToken});
    if (receipt.status !== 'applied') throw Error('expected applied');
    expect(f.planner.snapshot().focusSessions).toHaveLength(0); f.planner.undo(receipt.transactionId);
    expect(f.planner.snapshot().focusSessions[0]?.title).toBe('刚完成的练习');
  });

  it('resolves real block, task, course and goal links and asks about ambiguous names', async () => {
    const f = fixture();
    const links = f.repository.transact(state => {
      const course = newEntity(state,'course',{title:'合成课程',weekday:1,termStart:'2030-05-06',startTime:'08:00',endTime:'09:00',firstWeek:1,lastWeek:8});
      const goal = newEntity(state,'goal',{title:'合成目标'});
      const task = newEntity(state,'task',{title:'习题任务',courseId:course.id,goalId:goal.id});
      const block = newEntity(state,'block',{title:'习题时段',kind:'work',taskId:task.id,start:'2030-05-15T16:00:00+08:00',end:now});
      return {blockId:block.id,taskId:task.id,courseId:course.id,goalId:goal.id};
    });
    const started = await f.send('给习题时段开番茄钟',{type:'start',mode:'pomodoro',subject:'习题时段'});
    expect(started.focusAction).toMatchObject(links);
    await f.send('补记刚才在习题时段练习半个小时',{type:'create',title:'练习',subject:'习题时段'});
    expect(f.planner.snapshot().focusSessions).toMatchObject([{...links,durationSeconds:1800}]);
    f.repository.transact(state => newEntity(state,'task',{title:'习题任务'}));
    const ambiguous = await f.send('给习题任务开番茄钟',{type:'start',mode:'pomodoro',subject:'习题任务'});
    expect(ambiguous.focusAction).toBeUndefined();
    expect(ambiguous.conversationState?.phase).toBe('clarification');
  });

  it('rejects confirmation when a different device changed the proposed deletion target', async () => {
    const f = fixture(), session = f.seed('练习','2030-05-15T11:00:00+08:00',600);
    const preview = (await f.send('删除今天的练习专注记录',{type:'delete',match:'练习'})).mutationResult;
    if (preview?.status !== 'preview') throw Error('expected preview');
    const edited = f.planner.mutate({
      operationId:'other-device', origin:'manual', confirmed:false,
      mutations:[{type:'updateFocusSession', id:session.id, expectedVersion:session.version, values:{note:'修订'}}],
    });
    expect(edited.status).toBe('applied');
    const result = f.planner.mutate({...preview.proposedRequest,confirmed:true,confirmationToken:preview.confirmationToken});
    expect(result.status).toBe('clarification');
    expect(f.planner.snapshot().focusSessions[0]?.note).toBe('修订');
  });

  it('negotiates timer actions, reads the device status and excludes attachments or history as fresh authorization', async () => {
    const f = fixture(); const task = f.repository.transact(state => newEntity(state,'task',{title:'高数'}));
    const start = {type:'start',mode:'pomodoro',title:'高数'} as const;
    expect((await f.send('帮我开一个10分钟高数番茄钟',start)).focusAction).toEqual({...start,plannedMinutes:10,taskId:task.id});
    expect((await f.send('开启高数番茄钟',start,{focusTimer:undefined})).focusAction).toBeUndefined();
    const status = {phase:'running', mode:'stopwatch', title:'习题', elapsedMs:721000,plannedMinutes:null,timerId:'device-timer'} as const;
    expect((await f.send('我现在专注了多久？',summary,{focusTimer:status},true)).reply).toContain('12 分钟 1 秒');
    expect((await f.send('暂停番茄钟',{type:'pause'},{focusTimer:status})).focusAction).toEqual({type:'pause',timerId:'device-timer'});
    expect((await f.send('不要开番茄钟',start)).focusAction).toBeUndefined();
    expect((await f.send('删掉今天14:00到14:45的高数专注记录',{type:'create',title:'高数'})).mutationResult).toBeNull();
    expect((await f.send('查看刚才高数40分钟的记录',{type:'create',title:'高数'})).mutationResult).toBeNull();
    expect((await f.send('给并不存在的课程开番茄钟',{...start,subject:'并不存在'})).conversationState?.phase).toBe('clarification');
    expect((await f.send('好的',start,{history:[{role:'user',text:'开始计时'},{role:'assistant',text:'已开始',outcome:{domain:'focus',phase:'query'}}]})).focusAction).toBeUndefined();
    const attachment = await f.send('',start,{documents:[{label:'合成.txt',text:'开始计时'}]});
    expect(attachment.focusAction).toBeUndefined(); expect(f.planner.snapshot().focusSessions).toHaveLength(0);
  });
});
