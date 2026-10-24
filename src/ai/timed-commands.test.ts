import { describe, expect, it } from 'vitest';
import { CommandIntentSchema } from '../shared/contracts';
import { explicitReminderStart, groundTimedCommand } from './timed-commands';

describe('explicit reminder time grounding', () => {
  it.each(['后天晚上6点提醒我取材料', '后天晚上六点提醒我取材料', '后天18:00提醒我取材料'])('grounds a unique evening time against the command clock (%s)', text => {
    expect(explicitReminderStart(text, '2030-04-12T14:00:00+08:00')).toBe('2030-04-14T18:00:00+08:00');
  });
  it.each(['后天6点提醒我取材料', '后天晚上六点之前提醒我取材料', '后天晚上六点截止，提醒我取材料', '后天晚上六点或七点提醒我取材料', '明后天晚上六点提醒我取材料', '不要后天晚上六点提醒我取材料', '每周五晚上六点提醒我取材料'])('leaves ambiguity, deadlines, recurrence and negation to the semantic command (%s)', text => {
    expect(explicitReminderStart(text, '2030-04-12T14:00:00+08:00')).toBeNull();
  });
  it.each(['4月15日要取材料，明天晚上六点提醒我准备', '2030年4月15日要取材料，明天晚上六点提醒我准备', '4月15日要取材料，4月13日晚上六点提醒我准备', '15号要取材料，明天晚上六点提醒我准备'])('does not override the semantic reminder date when multiple dates have different roles (%s)', text => {
    const intent = CommandIntentSchema.parse({ kind: 'mutate', reply: '准备材料', mutations: [{ type: 'createScheduledTask', values: { title: '准备材料' }, start: '2030-04-13T18:00:00+08:00', end: null }] });
    expect(explicitReminderStart(text, '2030-04-12T14:00:00+08:00')).toBeNull();
    expect(groundTimedCommand(intent, { operationId: 'synthetic-multiple-dates', text }, '2030-04-12T14:00:00+08:00')).toEqual(intent);
  });
});
