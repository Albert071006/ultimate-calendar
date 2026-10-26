import { describe, expect, it } from 'vitest';
import { qqSearchInfo } from './qq-search';

describe('QQ search assistance', () => {
  it('provides group, real sending time and a search keyword without inventing a navigation URL', () => {
    const result = qqSearchInfo({ groupId: '12345', groupName: '示例学习群', senderName: '小林', sentAt: '2026-10-25T18:20:00+08:00', text: '\n 周三交练习\n补充说明' });
    expect(result.keyword).toBe('周三交练习');
    expect(result.information).toContain('2026-10-25 18:20:00');
    expect(result.information).toContain('示例学习群（12345）');
    expect(result.information).not.toContain('mqqapi:');
  });
  it('does not misrepresent extracted attachment text or import time as searchable original evidence', () => {
    const result = qqSearchInfo({ groupId: '12345', sentAt: null, text: '附件第三页的 OCR', attachment: true });
    expect(result.keyword).toBe('');
    expect(result.information).toContain('发送时间：未取得');
    expect(result.information).not.toContain('OCR');
  });
});
