import { useEffectEvent, useLayoutEffect, useRef } from 'react';

const gestureGapMs = 250;
const minimumPixels = 32;

function pagingDistance(event: WheelEvent): number {
  const target = event.target;
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || !(target instanceof Element)) return 0;
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false]), .a2-drawer, .a2-assist, .a2-pop')) return 0;

  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  if (!horizontal && !event.shiftKey && !target.closest('.a2-toolbar, .a2-days, .a2-m-head')) {
    const month = target.closest('.a2-month');
    if (!month || month.scrollHeight > month.clientHeight + 1) return 0;
  }
  if (target.ownerDocument.querySelector('dialog[open], [role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])')) return 0;

  // Chromium may deliver Shift + wheel on X instead of Y. Line/page wheels need the same pixel threshold.
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
  return (horizontal ? event.deltaX : event.deltaY) * scale;
}

export function useCalendarWheel(turnPage: (direction: -1 | 1) => void) {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useEffectEvent(turnPage);
  useLayoutEffect(() => {
    const page = root.current;
    if (!page) return;
    let lastWheel = -Infinity, distance = 0, paged = false;
    function wheel(event: WheelEvent) {
      const delta = pagingDistance(event);
      if (!delta) return;
      const now = performance.now();
      // Require a quiet interval after a page turn, including the tail of a trackpad gesture.
      if (now - lastWheel >= gestureGapMs) { distance = 0; paged = false; }
      lastWheel = now;
      if (paged) { event.preventDefault(); return; }
      if (Math.sign(delta) !== Math.sign(distance)) distance = 0;
      distance += delta;
      if (Math.abs(distance) < minimumPixels) return;
      event.preventDefault();
      paged = true;
      navigate(distance > 0 ? 1 : -1);
    }
    page.addEventListener('wheel', wheel, { passive: false });
    return () => page.removeEventListener('wheel', wheel);
  }, []);
  return root;
}
