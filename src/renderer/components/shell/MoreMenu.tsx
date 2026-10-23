import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; ariaLabel?: string }

/** "⋯" button holding a row's secondary actions. */
export function MoreMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className="a2-more" ref={root}>
      <button type="button" className="ui-more" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && (
        <div className="ui-menu ui-overlay" role="menu">
          {items.map(item => (
            <button key={item.label} role="menuitem" className={item.danger ? "danger" : ""} disabled={item.disabled} aria-label={item.ariaLabel}
              onClick={() => { setOpen(false); item.onSelect(); }}>{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
