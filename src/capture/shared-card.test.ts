import { describe, expect, it } from 'vitest';
import { normalizeMessage } from './service';
import { sharedCardText } from './shared-card';

const segment = (card: unknown) => ({ type: 'json', data: { data: JSON.stringify(card) } });
const document = (extra = {}) => ({ app: 'com.tencent.miniapp_01', prompt: '[QQ小程序]第八周可考试时间',
  meta: { detail_1: { title: '腾讯文档', desc: '第八周可考试时间', qqdocurl: 'https://docs.qq.com/sheet/synthetic',
    url: 'https://m.q.qq.com/a/s/synthetic', icon: 'https://example.test/icon', host: { uin: 'private-user' }, ...extra } },
  config: { token: 'private-card-token' } });

describe('QQ shared-card evidence', () => {
  it('extracts the visible document title and ordinary URL without private metadata or preview downloads', () => {
    const result = sharedCardText(segment(document()));
    expect(result).toBe('[分享卡片]\n腾讯文档\n第八周可考试时间\nhttps://docs.qq.com/sheet/synthetic');
    expect(result).not.toMatch(/private-|icon|m\.q\.qq/);
  });

  it('keeps the card alongside outer text and mentions in the normalized message', () => {
    const message = normalizeMessage({ group_id: '200', message_id: 'synthetic-card', time: 1792713600,
      message: [{ type: 'at', data: { qq: 'all' } }, segment(document()), { type: 'text', data: { text: '请大家填写本人可用时间' } }] }, '100', new Map());
    expect(message?.text).toContain('@全体成员');
    expect(message?.text).toContain('第八周可考试时间');
    expect(message?.text).toContain('https://docs.qq.com/sheet/synthetic');
    expect(message?.text).toContain('请大家填写本人可用时间');
    expect(message?.attachments).toEqual([]);
    expect(message?.segments).toHaveLength(3);
  });

  it('reads an ordinary web share and leaves its content as untrusted evidence', () => {
    expect(sharedCardText(segment({ app: 'com.tencent.structmsg', meta: { news: {
      title: '合成报名表', desc: '请参与者填写', jumpUrl: 'https://example.test/register',
    } } }))).toBe('[分享卡片]\n合成报名表\n请参与者填写\nhttps://example.test/register');
  });

  it.each(['javascript:alert(1)', 'file:///C:/private.txt', 'https://user:secret@example.test', 'not-a-url'])('rejects a non-web or credential-bearing link: %s', url => {
    const result = sharedCardText(segment(document({ qqdocurl: url, url: '' })));
    expect(result).not.toContain(url);
    expect(result).toContain('第八周可考试时间');
  });

  it.each(['{', '[]', 'null', 'x'.repeat(100_001)])('tolerates malformed or oversized JSON without exposing the payload', data => {
    expect(sharedCardText({ type: 'json', data: { data } })).toBe('');
  });

  it('marks unsupported cards as unread instead of silently treating them as empty', () => {
    const message = normalizeMessage({ group_id: '200', message_id: 'unsupported', time: 1792713600,
      message: [segment({ app: 'unrecognized', secret: 'do-not-copy' })] }, '100', new Map());
    expect(message?.text).toBe('[采集提示：分享卡片未取得可读标题或链接，请手动查看]');
    expect(message?.text).not.toContain('do-not-copy');
  });
});
