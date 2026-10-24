import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import "./EditPanel.css";

/**
 * The side edit panel. It covers the calendar's drawer (or slides over other pages) instead of blocking the
 * whole window, so the calendar stays visible while a time is adjusted. Esc closes it unless a modal is above.
 */
export function EditPanel({ title, children, onClose, overlay = false }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Slides over the page instead of taking the calendar's side slot. */
  overlay?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input:not([readonly]),textarea,select")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== ref.current) return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <section ref={ref} className={`a2-edit${overlay ? " overlay" : ""}`} role="dialog" aria-modal="false" aria-label={title}>
      <header className="a2-edit-h">
        <h2>{title}</h2>
        <button className="ui-btn sm ghost icon" onClick={onClose} aria-label="关闭编辑" title="关闭（Esc）"><X aria-hidden="true" /></button>
      </header>
      <div className="a2-edit-b">{children}</div>
    </section>
  );
}
