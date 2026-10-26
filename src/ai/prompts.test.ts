import { describe, expect, it } from 'vitest';
import { SourceSchema, type CommandRequest } from '../shared/contracts';
import { candidateSummaryInstructions, commandMessages, conversationEditInstructions, eventExtractionInstructions, extractionMessages, temporalExtractionInstructions, titleEditInstructions } from './prompts';
import { batchMessages } from '../capture/analysis';

describe('shared temporal instructions', () => {
  it('uses the same grounded month/day, weekday, Chinese-clock and deadline-range rules for manual and QQ imports', () => {
    const at = '2026-10-23T12:00:00+08:00';
    const source = SourceSchema.parse({ id: 'source', version: 1, createdAt: at, updatedAt: at, importedAt: at, kind: 'text', text: '10月24日下午四点', sentAt: at });
    const manual = extractionMessages(source, [])[0]!.content;
    const capture = batchMessages([], [], [], [])[0]!.content;
    expect(manual).toContain(temporalExtractionInstructions); expect(capture).toContain(temporalExtractionInstructions);
    expect(manual).toContain(eventExtractionInstructions); expect(capture).toContain(eventExtractionInstructions);
    expect(manual).toContain(candidateSummaryInstructions); expect(capture).toContain(candidateSummaryInstructions);
    expect(manual).not.toContain('explicit(明确完整年月日)');
    expect(temporalExtractionInstructions).toContain('183天');
    expect(temporalExtractionInstructions).toContain('没有截止钟点保持 time=null');
  });
});

describe('conversational edit instructions', () => {
  it('separates the current authorization from history while allowing short clarification answers', () => {
    const history: CommandRequest['history'] = [
      { role: 'user', text: '把取材料那条标题里的地点去掉' },
      { role: 'assistant', text: '哪条？' },
    ];
    const messages = commandMessages({ blocks: [{ id: 'block-1', title: '去资料室取申请材料' }] }, '去资料室取申请材料', history);
    expect(messages).toHaveLength(4);
    expect(messages[0]!.content).toContain(conversationEditInstructions);
    expect(messages[0]!.content).toContain(titleEditInstructions);
    expect(messages[0]!.content).toContain('当前短答是在补全同一次请求');
    expect(messages[0]!.content).toContain('历史里已执行、已撤销、已取消、已拒绝或被新话题取代的操作不得重新执行');
    expect(messages.slice(1,3)).toEqual(history.map(({role,text})=>({role,content:text})));
    expect(JSON.parse(messages.at(-1)!.content as string)).toMatchObject({ userCommand: '去资料室取申请材料' });
  });

  it('directs title deletion to a minimal patch while preserving location and distinguishing stored activities from colloquial tasks', () => {
    expect(titleEditInstructions).toContain('values 只含 title');
    expect(titleEditInstructions).toContain('标题里移除一个地点词不等于清空 location');
    expect(titleEditInstructions).toContain('不要调用 delete、removeTask、finishTask、cancelRecurringEvent');
    expect(conversationEditInstructions).toContain('查找 context.tasks 和 context.blocks');
    expect(conversationEditInstructions).toContain('不能因为 tasks 没有就声称不存在');
    expect(conversationEditInstructions).toContain('如果多个候选都合理');
  });
});
