import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import './CategoryCombobox.css';

/** Suggestions assist a manual choice; opening the list never changes the value. */
export function CategoryCombobox({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (value: string) => void }) {
  const id = useId(), root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false), [filter, setFilter] = useState<string | null>(null), [active, setActive] = useState(-1);
  const available = [...new Set(options)];
  const visible = filter?.trim() ? available.filter(option => option.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) : available;
  const openAll = () => { setFilter(null); setActive(-1); setOpen(true); };
  const choose = (category: string) => { onChange(category); input.current?.focus(); setOpen(false); setActive(-1); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open && active >= 0) list.current?.children.item(active)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);
  const keyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
    else if (event.key === 'Tab') setOpen(false);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { openAll(); setActive(event.key === 'ArrowDown' ? 0 : available.length - 1); }
      else if (visible.length) setActive(index => event.key === 'ArrowDown' ? (index + 1) % visible.length : (index <= 0 ? visible.length : index) - 1);
    } else if (event.key === 'Enter' && open && visible[active] !== undefined) {
      event.preventDefault(); event.stopPropagation(); choose(visible[active]!);
    }
  };
  return <div className="ledger-category-field" ref={root} onKeyDown={keyDown} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <label htmlFor={id}>分类</label>
    <div className="ledger-category-combobox">
      <input id={id} ref={input} required maxLength={100} value={value} autoComplete="off" role="combobox" aria-autocomplete="list"
        aria-expanded={open} aria-controls={open ? `${id}-options` : undefined} aria-activedescendant={open && visible[active] !== undefined ? `${id}-option-${active}` : undefined}
        onFocus={openAll} onChange={event => { onChange(event.target.value); setFilter(event.target.value); setActive(-1); setOpen(true); }} />
      <button type="button" className="ledger-category-toggle" aria-label="显示全部分类" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? `${id}-options` : undefined} onMouseDown={event => event.preventDefault()} onClick={() => { input.current?.focus(); openAll(); }}>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && <ul id={`${id}-options`} ref={list} className="ledger-category-options" role="listbox" aria-label="分类建议">
        {visible.map((category, index) => <li id={`${id}-option-${index}`} key={category} role="option" aria-selected={category === value}
          className={index === active ? 'active' : undefined} onMouseDown={event => event.preventDefault()} onClick={() => choose(category)}>
          <span>{category}</span>{category === value && <span className="ledger-category-check" aria-hidden="true">✓</span>}
        </li>)}
        {!visible.length && <li className="ledger-category-empty" role="presentation">无匹配分类，可直接使用填写的新名称</li>}
      </ul>}
    </div>
  </div>;
}
