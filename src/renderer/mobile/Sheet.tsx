import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

const focusable = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]';

/**
 * The phone's bottom sheet: a scrim, a grip, an optional heading and a scrolling body with a fixed footer.
 * Only the topmost dialog reacts to Escape and keeps Tab inside; focus returns to the opener on close.
 * `bare` leaves the heading to the content, for cards that already carry their own title and close button.
 */
export function Sheet({ title, onClose, children, footer, bare = false, className = '' }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  bare?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== ref.current) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(focusable) ?? []);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="m-layer">
      <div className="m-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className={`m-sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="m-sheet-grip" aria-hidden="true" />
        {!bare && <header className="m-sheet-head">
          <h2>{title}</h2>
          <button className="m-icon" onClick={onClose} aria-label="关闭"><X aria-hidden="true" /></button>
        </header>}
        <div className="m-sheet-body">{children}</div>
        {footer && <footer className="m-sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}
