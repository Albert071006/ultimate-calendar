import { describe, expect, it } from 'vitest';
import { isAddressedElsewhere, mentionLabel, recipientContext } from './recipients';
const at = (qq: unknown) => ({ type: 'at', data: { qq } });
const text = (value: string) => ({ type: 'text', data: { text: value } });
const message = (segments: unknown[]) => ({ accountId: '100', senderId: '300', segments });

describe('QQ recipient identity', () => {
  it.each([
    [[text('明天交报告')], 'unspecified'],
    [[at('100')], 'self'],
    [[at(100)], 'self'],
    [[at('all')], 'all'],
    [[at('200'), at('300')], 'others'],
    [[at('200'), at('100')], 'self'],
    [[at('200'), at('all')], 'all'],
    [[at('200'), at(undefined)], 'unknown'],
    [[at(Number.MAX_SAFE_INTEGER + 1)], 'unknown'],
  ] as const)('classifies only reliable outer mentions', (segments, audience) => {
    const value = message([...segments]);
    expect(recipientContext(value).audience).toBe(audience);
    expect(isAddressedElsewhere(value)).toBe(audience === 'others');
  });
  it('does not let a nested @all override the outer address to another person', () => {
    const forwarded = { type: 'node', data: { content: [at('all'), text('明天开会')] } };
    expect(isAddressedElsewhere(message([at('200'), forwarded]))).toBe(true);
    expect(recipientContext(message([forwarded])).audience).toBe('unspecified');
  });
  it('preserves ambiguous CQ history and literal code examples instead of treating text as a verified mention', () => {
    expect(recipientContext(message([text('[CQ:at,qq=200] 请交材料')])).audience).toBe('unknown');
    expect(recipientContext(message([text('[CQ:at,qq=100,name=示例] 请交材料')])).audience).toBe('unknown');
    expect(recipientContext(message([text('[CQ:at,qq=all] 请交材料')])).audience).toBe('unknown');
    expect(recipientContext(message([text('&#91;CQ:at,qq=200&#93; @负责人 请查看')])).audience).toBe('unspecified');
    expect(recipientContext(message([text('[CQ:at,qq=200,qq=100]')])).audience).toBe('unknown');
    expect(isAddressedElsewhere(message([at('200'), text('参考这段代码：[CQ:at,qq=100]')]))).toBe(false);
    expect(isAddressedElsewhere({ ...message([]), text: '[CQ:at,qq=200] 通知' })).toBe(false);
  });
  it('preserves mixed addressee order and sender perspective without sending QQ numbers as labels', () => {
    const context = recipientContext(message([at('200'), text('负责签到；'), at('100'), text('准备材料')]));
    expect(context).toEqual({ audience: 'self', sender: 'other', addressedText: '@其他成员负责签到；@我准备材料', truncated: false });
    expect(recipientContext({ ...message([]), senderId: '100' }).sender).toBe('self');
    expect(recipientContext({ ...message([]), senderId: null }).sender).toBe('unknown');
  });
  it('preserves unknown or incomplete addressing and bounds the auxiliary context', () => {
    expect(isAddressedElsewhere({ ...message([at('200')]), text: '[采集提示：消息超过 1000 个片段，只收录前 1000 个，请手动查看完整消息]' })).toBe(false);
    const context = recipientContext(message([at('200'), text('a'.repeat(7000)), at('100')]));
    expect(context.audience).toBe('self'); expect(context.truncated).toBe(true); expect(context.addressedText).toHaveLength(6000);
  });
  it('keeps long numeric identities exact', () => {
    expect(recipientContext({ accountId: '9007199254740993123', segments: [at('9007199254740993123')] }).audience).toBe('self');
    expect(mentionLabel('100', '100')).toBe('@我'); expect(mentionLabel('200', '100')).toBe('@其他成员');
  });
});
