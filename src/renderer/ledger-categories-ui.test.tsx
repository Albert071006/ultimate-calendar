// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, LedgerSnapshotSchema, type LedgerEntry } from '../shared/ledger';
import { summarizeLedger } from '../ledger/summary';
import { EntryEditor, type Change } from './components/ledger/editors';

afterEach(cleanup);
const stamp = '2026-01-15T12:00:00+08:00';
const original = LedgerEntrySchema.parse({ id: 'synthetic-postage', kind: 'expense', date: '2026-01-15', month: '2026-01',
  title: '合成快递费', category: '自定义寄件', amountCents: 1200, personalCents: 1200,
  cashflows: [{ accountId: 'alipay', deltaCents: -1200 }], version: 1, createdAt: stamp, updatedAt: stamp });
function setup(entry?: LedgerEntry) {
  const entries = [original];
  const snapshot = LedgerSnapshotSchema.parse({ revision: 1, entries, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [],
    summary: summarizeLedger({ entries, balanceSnapshots: [] }, { month: '2026-01' }) });
  const save = vi.fn(async (_changes: Change[]) => true);
  render(<EntryEditor snapshot={snapshot} entry={entry} busy={false} error="" save={save} close={vi.fn()} />);
  return save;
}

describe('open ledger category input', () => {
  it('starts without assuming food and saves a category outside all suggestions', async () => {
    const save = setup();
    const category = screen.getByLabelText('分类') as HTMLInputElement;
    expect(category.value).toBe('其他');
    const suggestions = Array.from(document.querySelectorAll<HTMLOptionElement>('#ledger-category-options option')).map(option => option.value);
    expect(suggestions).toContain('快递物流');
    expect(suggestions).toContain('自定义寄件');
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '合成社团物资' } });
    fireEvent.change(category, { target: { value: '社团活动材料' } });
    fireEvent.change(screen.getByLabelText('实际支付（元）'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0][0]).toMatchObject({ entry: { category: '社团活动材料', amountCents: 1200, personalCents: 1200 } });
  });

  it('keeps an existing custom category while correcting only the note', async () => {
    const save = setup(original);
    expect((screen.getByLabelText('分类') as HTMLInputElement).value).toBe('自定义寄件');
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '合成备注补充' } });
    fireEvent.change(screen.getByLabelText('更正说明'), { target: { value: '补充备注' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更正' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0][0]).toMatchObject({ expectedVersion: 1, entry: {
      category: original.category, amountCents: original.amountCents, personalCents: original.personalCents, cashflows: original.cashflows,
    } });
  });
});
