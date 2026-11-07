// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CategoryCombobox } from './components/ledger/CategoryCombobox';
import { Modal } from './components/Modal';

afterEach(cleanup);
const options = ['餐饮', '交通', '其他', '自定义寄件'];
function setup(initial = '其他', modal = false) {
  const changed = vi.fn(), submit = vi.fn(), close = vi.fn();
  function Form() {
    const [value, setValue] = useState(initial);
    return <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <CategoryCombobox value={value} options={options} onChange={value => { setValue(value); changed(value); }} />
      <button type="submit">保存</button>
    </form>;
  }
  render(modal ? <Modal title="合成记账" onClose={close}><Form /></Modal> : <Form />);
  return { input: screen.getByRole('combobox', { name: '分类' }) as HTMLInputElement, changed, submit, close };
}

describe('manual category combobox', () => {
  it('shows every category on focus without clearing or changing the existing value', () => {
    const { input, changed } = setup();
    fireEvent.focus(input);
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.getByRole('option', { name: '自定义寄件' })).toBeTruthy();
    expect(input.value).toBe('其他');
    expect(changed).not.toHaveBeenCalled();
  });

  it('filters only after typing and the explicit arrow restores all suggestions without changing typed text', () => {
    const { input, changed } = setup();
    fireEvent.change(input, { target: { value: '寄件' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '显示全部分类' }));
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(input.value).toBe('寄件');
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('option', { name: '交通' }));
    expect(input.value).toBe('交通');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('allows a new custom name without forcing a suggestion', () => {
    const { input, changed } = setup('已有自定义');
    fireEvent.focus(input);
    expect(input.value).toBe('已有自定义');
    fireEvent.change(input, { target: { value: '社团材料' } });
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText('无匹配分类，可直接使用填写的新名称')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('社团材料');
    expect(changed).toHaveBeenCalledWith('社团材料');
  });

  it('uses arrows and Enter to select without submitting the editor and leaves text untouched on Escape', () => {
    const { input, submit } = setup();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: '交通' }).id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('交通');
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: '自定义寄件' }).id);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('交通');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on outside pointer, focus leaving the field, or Tab', () => {
    const { input } = setup();
    fireEvent.focus(input); fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.focus(input); fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.focus(input); fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: '保存' }) });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('其他');
  });

  it('consumes Escape for the open list before the enclosing dialog can close', () => {
    const { input, close } = setup('其他', true);
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not select or close during IME composition', () => {
    const { input, changed } = setup();
    fireEvent.focus(input); fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(input.value).toBe('其他');
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });
});
