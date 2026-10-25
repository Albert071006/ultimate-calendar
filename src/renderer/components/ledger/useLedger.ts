import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostCapabilities, PlannerClient } from '../../../shared/client';
import type { LedgerMutationRequest, LedgerSnapshot } from '../../../shared/ledger';
import { operationId, todayDate } from '../../calendar-layout';
import type { Change } from './editors';

/** One month of the local ledger with saving, undo and export; a retried save reuses its operation ID. */
export function useLedger(api: PlannerClient, host?: HostCapabilities) {
  const [month, setMonth] = useState(todayDate().slice(0, 7));
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const requestSequence = useRef(0), pendingMutation = useRef<{ signature: string; request: LedgerMutationRequest } | null>(null);
  const refresh = useCallback(async (preserveError = false) => {
    const sequence = ++requestSequence.current;
    try {
      const result = await api.ledgerSnapshot({ month });
      if (sequence !== requestSequence.current) return;
      if (result.ok) { setSnapshot(result.data); if (!preserveError) setError(''); }
      else setError(result.error.message);
    } catch { setError('账本暂未读取成功，请重新载入。'); }
  }, [api, month]);
  useEffect(() => { void refresh(); return api.onChanged(() => void refresh(true)); }, [api, refresh]);
  const save = async (changes: Change[]) => {
    if (!snapshot || busy) return false;
    const signature = JSON.stringify(changes);
    const request = pendingMutation.current?.signature === signature ? pendingMutation.current.request : { operationId: operationId(), expectedRevision: snapshot.revision, changes, month };
    pendingMutation.current = { signature, request }; setBusy(true); setError('');
    try {
      const result = await api.ledgerMutate(request);
      if (!result.ok) { setError(result.error.message); if (result.error.code === 'CONFLICT') { pendingMutation.current = null; void refresh(true); } return false; }
      pendingMutation.current = null;
      if (result.data.status !== 'queued') setSnapshot(result.data.snapshot);
      setNotice(result.data.message); return true;
    } catch { setError('尚未确认保存完成。请保留内容并重试，同一操作不会重复记账。'); return false; }
    finally { setBusy(false); }
  };
  const undo = async () => {
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.ledgerUndo({ operationId: operationId(), expectedRevision: snapshot.revision, month });
      if (result.ok) { setSnapshot(result.data.snapshot); setNotice(result.data.message); } else setError(result.error.message);
    } catch { setError('撤销尚未确认完成，请重新载入账本后核对。'); }
    finally { setBusy(false); }
  };
  const exportLedger = async (format: 'csv' | 'json') => {
    if (!host) return;
    setBusy(true); setError('');
    try {
      const result = await host.ledgerExport({ format, ...(format === 'csv' ? { month } : {}) });
      if (result.ok) { if (result.data) setNotice(`已导出${format === 'csv' ? '本月 CSV' : '完整账本'}：${result.data.path}`); }
      else if (result.error.code !== 'CANCELLED') setError(result.error.message);
    } catch { setError('导出尚未完成，请重试。'); }
    finally { setBusy(false); }
  };
  const moveMonth = (direction: number) => {
    const value = new Date(`${month}-01T00:00:00Z`); value.setUTCMonth(value.getUTCMonth() + direction); setMonth(value.toISOString().slice(0, 7));
  };
  return { month, setMonth, moveMonth, snapshot, busy, error, notice, refresh, save, undo, exportLedger };
}
export type Ledger = ReturnType<typeof useLedger>;
