import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

export const ASSISTANT_HEIGHT_KEY = 'ultimate-calendar:assistant-panel-height';
const defaultHeight = 420;
const clamp = (height: number, maximum: number) => Math.round(Math.min(maximum, Math.max(Math.min(180, maximum), height)));
function savedHeight() {
  try { const saved = Number(localStorage.getItem(ASSISTANT_HEIGHT_KEY)); return Number.isFinite(saved) && saved >= 80 && saved <= 4000 ? saved : defaultHeight; }
  catch { return defaultHeight; }
}

/** A local view preference; never enters calendar settings, history, or remote requests. */
export function useAssistantPanelSize(root: RefObject<HTMLElement | null>, expanded: boolean) {
  const [preferred, setPreferred] = useState(savedHeight);
  const [maximum, setMaximum] = useState(() => Math.max(0, window.innerHeight - 128));
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startY: number; height: number } | null>(null);
  const latestHeight = useRef(preferred);
  const height = clamp(preferred, maximum);
  latestHeight.current = height;
  const persist = (value: number) => { try { localStorage.setItem(ASSISTANT_HEIGHT_KEY, String(value)); } catch { /* The view remains resizable when storage is unavailable. */ } };
  useLayoutEffect(() => {
    if (!expanded) return;
    const measure = () => {
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? window.innerHeight);
      const rect = root.current?.getBoundingClientRect();
      const anchor = rect && (rect.height || rect.top) ? rect.top : bottom - 80;
      setMaximum(Math.max(0, Math.floor(Math.min(anchor - 8, bottom - 80) - (top + 48))));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    window.addEventListener('resize', measure); window.visualViewport?.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, [root, expanded]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const move = (event: globalThis.PointerEvent) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      event.preventDefault();
      const next = clamp(current.height + current.startY - event.clientY, maximum);
      latestHeight.current = next; setPreferred(next);
    };
    const finish = (event?: globalThis.PointerEvent) => {
      if (!drag.current || event && event.pointerId !== drag.current.pointerId) return;
      drag.current = null; setResizing(false); persist(latestHeight.current);
    };
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); finish(); };
  }, [expanded, maximum]);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
    drag.current = { pointerId: event.pointerId, startY: event.clientY, height }; setResizing(true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window listeners also cover native platforms without pointer capture. */ }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'ArrowUp' ? height + 32 : event.key === 'ArrowDown' ? height - 32 : event.key === 'Home' ? 0 : event.key === 'End' ? maximum : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation(); const value = clamp(next, maximum); setPreferred(value); persist(value);
  };
  return { height, maximum, minimum: Math.min(180, maximum), resizing, onPointerDown, onKeyDown };
}
