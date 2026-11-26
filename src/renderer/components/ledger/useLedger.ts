import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostCapabilities, PlannerClient } from '../../../shared/client';
import type { LedgerMutationRequest, LedgerSnapshot } from '../../../shared/ledger';
import { operationId, todayDate } from '../../calendar-layout';
import { useFeedback } from '../../hooks/useFeedback';
import { downloadFile } from '../../download-file';
import type { Change } from './editors';

/** One month of the local ledger with saving, undo and export; a retried save reuses its operation ID. */
export function useLedger(api: PlannerClient, host?: HostCapabilities) {
  const [month, setMonth] = useState(todayDate().slice(0, 7));
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { setNotice, setError: reportError } = useFeedback();
  const mounted = useRef(false), activeMonth = useRef(month), writing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  activeMonth.current = month;
  const fail = (message: string) => mounted.current ? setError(message) : reportError(message);
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
  useEffect(() => { void refresh(); return api.onChanged(event => { if (!event?.domains || event.domains.includes('ledger')) void refresh(true); }); }, [api, refresh]);
  const save = async (changes: Change[]) => {
    if (!snapshot || busy || writing.current) return false;
    const signature = JSON.stringify(changes);
    const request = pendingMutation.current?.signature === signature ? pendingMutation.current.request : { operationId: operationId(), expectedRevision: snapshot.revision, changes, month };
    pendingMutation.current = { signature, request }; writing.current = true; setBusy(true); setError('');
    try {
      const result = await api.ledgerMutate(request);
      if (!result.ok) {
        fail(result.error.message);
        if (result.error.code === 'CONFLICT') {
          pendingMutation.current = null;
          if (mounted.current && month === activeMonth.current) void refresh(true);
        }
        return false;
      }
      pendingMutation.current = null;
      const receipt = result.data;
      if (receipt.status === 'queued') setNotice(receipt.message);
      else {
        if (month === activeMonth.current) setSnapshot(receipt.snapshot);
        const latest = receipt.status === 'saved' || receipt.snapshot.audit.at(-1)?.operationId === request.operationId;
        setNotice(receipt.message, latest && receipt.undoAvailable ? () => void undo(receipt.snapshot.revision) : undefined);
      }
      return true;
    } catch { fail('尚未确认保存完成。请保留内容并重试，同一操作不会重复记账。'); return false; }
    finally { writing.current = false; setBusy(false); }
  };
  const undo = async (expectedRevision = snapshot?.revision) => {
    if (expectedRevision === undefined || writing.current) return;
    writing.current = true; setBusy(true); setError('');
    // A receipt can outlive its page. Never undo a later write in its place.
    try {
      const result = await api.ledgerUndo({ operationId: operationId(), expectedRevision, month });
      if (result.ok) {
        if (month === activeMonth.current) setSnapshot(result.data.snapshot);
        setNotice(result.data.message);
      } else fail(result.error.message);
    } catch { fail('撤销尚未确认完成，请重新载入账本后核对。'); }
    finally { writing.current = false; setBusy(false); }
  };
  const exportLedger = async (format: 'csv' | 'json') => {
    if (!host && !api.ledgerExportData) return;
    setBusy(true); setError('');
    try {
      const request = { format, ...(format === 'csv' ? { month } : {}) };
      const label = format === 'csv' ? '本月 CSV' : '完整账本';
      if (host) {
        const result = await host.ledgerExport(request);
        if (result.ok) { if (result.data) setNotice(`已导出${label}：${result.data.path}`); }
        else if (result.error.code !== 'CANCELLED') fail(result.error.message);
      } else if (api.ledgerExportData) {
        const result = await api.ledgerExportData(request);
        if (!result.ok) { fail(result.error.message); return; }
        downloadFile(new Blob([result.data.content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }),
          format === 'csv' ? `账本-${month}.csv` : '完整账本.json');
        setNotice(`已开始下载${label}`);
      }
    } catch { fail('导出尚未完成，请重试。'); }
    finally { setBusy(false); }
  };
  const moveMonth = (direction: number) => {
    const value = new Date(`${month}-01T00:00:00Z`); value.setUTCMonth(value.getUTCMonth() + direction); setMonth(value.toISOString().slice(0, 7));
  };
  return { month, setMonth, moveMonth, snapshot, busy, error, setError, refresh, save, undo, exportLedger };
}
export type Ledger = ReturnType<typeof useLedger>;
