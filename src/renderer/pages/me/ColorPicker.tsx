import { useEffect, useRef, useState, type CSSProperties } from "react";
import { PALETTE, PRIMARY_COLOR_COUNT, colorName } from "../../../shared/palette";

/**
 * A color chip that opens the 16-color palette. Colors already held by another current course or active goal
 * carry a dot; they can still be chosen, the dot only warns that two things will look alike.
 */
export function ColorPicker({ name, color, used, busy, pick }: {
  /** Whose color this is, e.g. the course title. */
  name: string;
  color: string | null;
  /** Colors held by other courses and goals (this item's own color excluded). */
  used: string[];
  busy: boolean;
  pick: (hex: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key, true); };
  }, [open]);
  const swatch = (hex: string) => (
    <button key={hex} type="button" className={`${used.includes(hex) ? "used" : ""}${hex === color ? " cur" : ""}`} style={{ "--c": hex } as CSSProperties}
      aria-label={`${colorName(hex)}${used.includes(hex) ? "（已被使用）" : ""}`} aria-pressed={hex === color} title={colorName(hex)} disabled={busy}
      onClick={() => { setOpen(false); if (hex !== color) pick(hex); }} />
  );
  return (
    <div className="a2-color" ref={root}>
      <button type="button" className="a2-sw" aria-haspopup="dialog" aria-expanded={open} aria-label={`${name}的颜色：${color ? colorName(color) : "未设定"}`} onClick={() => setOpen(!open)}>
        <i style={{ "--c": color ?? "transparent" } as CSSProperties} />{color ? colorName(color) : "未设定"}
      </button>
      {open && (
        <div className="a2-palette ui-overlay" role="group" aria-label={`${name}的颜色`}>
          <h4>{name}的颜色</h4>
          <p className="ui-hint">带圆点的颜色已被其他课程或目标使用</p>
          <div className="pal">{PALETTE.slice(0, PRIMARY_COLOR_COUNT).map(value => swatch(value.hex))}</div>
          <p className="pal-sep">相近备用色</p>
          <div className="pal">{PALETTE.slice(PRIMARY_COLOR_COUNT).map(value => swatch(value.hex))}</div>
        </div>
      )}
    </div>
  );
}
