import { afterEach, describe, expect, it } from 'vitest';
import { CommandRequestSchema, CommandResultSchema, type CommandRequest } from '../shared/contracts';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { commandMessages } from './prompts';
import { ledgerContext, ledgerMessages } from './ledger';

const now = '2026-10-23T21:30:00+08:00';
const services: LedgerService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });

function bothStages(request: CommandRequest) {
  const ledger = createLedgerService(':memory:', { now: () => new Date(now) });
  services.push(ledger);
  return [
    commandMessages({ now, currentUiDomain: 'calendar' }, request.text, request.history ?? []),
    ledgerMessages(ledgerContext(ledger.snapshot('2026-10'), request, now), request),
  ];
}

describe('assistant conversation transport', () => {
  it('preserves transaction facts as native user turns when a short reply resolves domain clarification', () => {
    const request = CommandRequestSchema.parse({ operationId: 'choose-bookkeeping', text: '记账', history: [
      { role: 'user', text: 'vpn14 支付宝' },
      { role: 'assistant', text: '这是记账还是安排日历事项？', outcome: { domain: 'calendar', phase: 'clarification' } },
    ] });
    for (const messages of bothStages(request)) {
      expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
      expect(messages[1]?.content).toBe('vpn14 支付宝');
      expect(messages[2]?.content).toContain('这是记账还是安排日历事项？');
      expect(JSON.parse(messages.at(-1)!.content as string)).toMatchObject({ userCommand: '记账', context: { now } });
      expect(JSON.parse(messages.at(-1)!.content as string)).not.toHaveProperty('history');
    }
  });

  it('keeps several unfinished clarification turns in order rather than reducing them to the latest question', () => {
    const request = CommandRequestSchema.parse({ operationId: 'answer-amount', text: '14元', history: [
      { role: 'user', text: '支付宝买VPN' },
      { role: 'assistant', text: '这是已经付款的消费，还是未来安排？', outcome: { domain: 'calendar', phase: 'clarification' } },
      { role: 'user', text: '已经买了，记账' },
      { role: 'assistant', text: '实际付了多少钱？', outcome: { domain: 'ledger', phase: 'clarification' } },
    ] });
    for (const messages of bothStages(request)) {
      expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
      expect(messages.filter(message => message.role === 'user').slice(0, -1).map(message => message.content)).toEqual(['支付宝买VPN', '已经买了，记账']);
      expect(messages[4]?.content).toContain('实际付了多少钱？');
      expect(JSON.parse(messages.at(-1)!.content as string).userCommand).toBe('14元');
    }
  });

  it('preserves lifecycle metadata independently from assistant prose and accepts older history without it', () => {
    for (const phase of ['clarification', 'saved', 'query', 'preview'] as const) {
      const outcome = { domain: 'ledger' as const, phase };
      const result = CommandResultSchema.parse({ reply: '处理结果', mutationResult: null, items: [], conversationState: outcome });
      expect(result.conversationState).toEqual(outcome);
      const request = CommandRequestSchema.parse({ operationId: `state-${phase}`, text: '继续', history: [
        { role: 'user', text: '午饭20元' }, { role: 'assistant', text: '处理结果', outcome: result.conversationState },
      ] });
      expect(request.history[1]?.outcome).toEqual(outcome);
      for (const messages of bothStages(request)) {
        const serialized = JSON.stringify(messages.slice(1));
        expect(serialized).toContain(phase);
        expect(serialized).toContain('ledger');
      }
    }
    expect(CommandRequestSchema.parse({ operationId: 'old-client', text: '支付宝', history: [
      { role: 'user', text: '午饭20元' }, { role: 'assistant', text: '用哪个账户？' },
    ] }).history).toEqual([{ role: 'user', text: '午饭20元' }, { role: 'assistant', text: '用哪个账户？' }]);
  });
});
