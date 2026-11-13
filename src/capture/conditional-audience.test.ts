import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { analyzeCapture } from './analysis';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'calendar-conditional-audience-')), path = join(root, 'planner.sqlite');
  const repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanup.push(() => { store.close(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  repository.saveSettings({ model: 'deepseek-flash', personalContext: '合成学院本科生；不担任小组负责人' });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  store.ingest([{ accountId: '100', groupId: '200', messageId: 'synthetic-conditional-notice', senderId: '300',
    sentAt: '2031-04-16T12:00:00+08:00', text, segments: [{ type: 'text', data: { text } }] }]);
  store.sealBatches({ force: true });
  return { repository, store, batch: store.claimBatch()! };
}
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));

describe('conditional audience extraction contract', () => {
  it.each([
    { text: '本轮体能测评未达标的同学请参加补测，已达标者无需参加。', title: '参加体能补测', condition: '仅本轮体能测评未达标者', uncertainty: '是否属于本轮补测对象待核对' },
    { text: '材料尚未提交的同学请补交登记材料，已交者无需重复提交。', title: '补交登记材料', condition: '仅尚未提交登记材料者', uncertainty: '本人是否已提交登记材料待核对' },
  ])('keeps a conditional $title pending without claiming the user satisfies its condition', async ({ text, title, condition, uncertainty }) => {
    const f = fixture(text); let sent: { model: string; messages: { role: string; content: string | { type: string; text: string }[] }[] } | undefined;
    await analyzeCapture({ ...f, getApiKey: async () => 'synthetic', canContinue: () => true, fetch: async (_url, request) => {
      sent = JSON.parse(String(request?.body));
      const input = JSON.parse((sent!.messages.find(message => message.role === 'user')!.content as { text: string }[])[0]!.text);
      return response({ candidates: [{ title, action: title, benefit: '', benefitKind: 'unknown', potentialBenefit: '',
        conditions: [condition], uncertainties: [uncertainty], sourceIds: [input.units[0].id], sourceQuote: text,
        deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null } }] });
    } });
    expect(sent!.model).toBe('deepseek-flash');
    const system = sent!.messages.find(message => message.role === 'system')!.content as string;
    expect(system).toContain('限定人群的真实通知仍需判断');
    expect(system).toContain('不能擅自认定用户已通过或不在范围内');
    expect(system).toContain('个人背景没提成绩');
    expect(system).toContain('原文仍须有真实行动要求');
    const input = JSON.parse((sent!.messages.find(message => message.role === 'user')!.content as { text: string }[])[0]!.text);
    expect(input.units).toHaveLength(1);
    expect(input.units[0]).toMatchObject({ text, recipient: { audience: 'unspecified', sender: 'other' } });
    expect(input.userProfile.personalContext).toBe('合成学院本科生；不担任小组负责人');
    const snapshot = f.repository.snapshot();
    expect(snapshot.candidates).toMatchObject([{ title, status: 'pending', conditions: [condition], uncertainties: [uncertainty] }]);
    expect(snapshot.candidates).toHaveLength(1); expect(snapshot.tasks).toHaveLength(0); expect(snapshot.blocks).toHaveLength(0);
    expect(f.store.batch(f.batch.id)?.status).toBe('applied');
  });

  it('does not fabricate a task or silently retry if the model still returns no candidate', async () => {
    const f = fixture('本轮体能测评未达标的同学请参加补测，已达标者无需参加。'); let requests = 0;
    await analyzeCapture({ ...f, getApiKey: async () => 'synthetic', canContinue: () => true, fetch: async () => { requests++; return response({ candidates: [] }); } });
    expect(requests).toBe(1); expect(f.repository.snapshot().candidates).toEqual([]); expect(f.repository.snapshot().tasks).toEqual([]);
    expect(f.store.batch(f.batch.id)?.status).toBe('applied');
  });
});
