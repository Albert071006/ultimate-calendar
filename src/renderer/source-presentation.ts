import type { Source } from '../shared/contracts';

/** The server keeps explicit placeholders after withholding or clearing analysis input. */
export function isExtractedQQSource(source: Pick<Source, 'label'>): boolean {
  return source.label === '采集电脑提炼' || source.label.startsWith('QQ提炼');
}
export function isClearedPhoneSource(source: Pick<Source, 'label'>): boolean {
  return source.label === '手机导入（原文已清理）';
}
