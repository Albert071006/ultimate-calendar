import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { friendlyReplyText } from './AssistantText';

export type ToastNotice = { text: string; undo?: () => void };

const duration = 4000;
const fadeDuration = 160;

/** Each receipt owns its undo action, including when the user has already switched pages. */
export function Toast({ notice, dismiss }: { notice: ToastNotice | null; dismiss: () => void }) {
  return notice && <div className="a2-toast-layer"><ToastPill notice={notice} dismiss={dismiss} /></div>;
}

function ToastPill({ notice, dismiss }: { notice: ToastNotice; dismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [fading, setFading] = useState(false);
  const paused = hovered || (focused && !!notice.undo);
  const clock = useRef({ notice, remaining: duration });
  const expire = useEffectEvent(dismiss);

  useEffect(() => {
    if (!notice.undo) setFocused(false);
    if (clock.current.notice !== notice) clock.current = { notice, remaining: duration };
    setFading(false);
    if (paused) return;
    const current = clock.current;
    const start = Date.now();
    const fade = window.setTimeout(() => setFading(true), Math.max(0, current.remaining - fadeDuration));
    const end = window.setTimeout(expire, current.remaining);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(end);
      current.remaining = Math.max(0, current.remaining - (Date.now() - start));
    };
  }, [notice, paused]);

  const text = notice.undo ? notice.text.replace(/[，,；;。]?\s*可撤销[。.!！]?\s*$/, '') : notice.text;
  return <div className={`a2-toast${fading && !paused ? ' fading' : ''}`} role="status" aria-atomic="true"
    onPointerEnter={event => { if (event.pointerType !== 'touch') setHovered(true); }} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
    <span>{friendlyReplyText(text)}</span>
    {notice.undo && <button type="button" onClick={() => { dismiss(); notice.undo?.(); }}>撤销</button>}
  </div>;
}
