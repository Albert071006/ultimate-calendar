import type { Source } from './contracts';

export const CLEARED_CAPTURE_TEXT = '这份采集原文已清理。';

export function clearedCaptureSource(source: Source): Source {
  if (!source.captureRef) return source;
  return {
    ...source, kind: 'text', text: CLEARED_CAPTURE_TEXT, imageDataUrl: null, error: null,
    label: '已清理的采集来源',
    captureRef: { ...source.captureRef, locator: '原文已清理', transcribed: false, cleared: true },
  };
}
