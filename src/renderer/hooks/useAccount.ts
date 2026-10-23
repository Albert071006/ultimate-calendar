import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountState } from '../../shared/account';
import type { DesktopAPI } from '../../shared/contracts';

/** Account updates are independent of planner refreshes and never reset form drafts. */
export function useAccount(api: DesktopAPI | undefined) {
  const [state, setState] = useState<AccountState | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(false), revision = useRef(0), inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (!api?.accountSnapshot || !api.onAccountChanged) return () => { alive.current = false; };
    const unsubscribe = api.onAccountChanged(next => {
      revision.current++;
      setState(next);
      setError('');
    });
    const start = revision.current;
    void api.accountSnapshot().then(result => {
      if (!alive.current || start !== revision.current) return;
      if (result.ok) setState(result.data);
      else setError(result.error.message);
    }).catch(() => { if (alive.current) setError('暂时无法读取账户信息，请重试'); });
    return () => { alive.current = false; unsubscribe(); };
  }, [api]);
  const refresh = useCallback(async () => {
    if (!api?.refreshAccount || inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    setError('');
    const start = revision.current;
    try {
      const result = await api.refreshAccount();
      if (!alive.current) return;
      if (result.ok) { if (start === revision.current) setState(result.data); }
      else setError(result.error.message);
    } catch { if (alive.current) setError('刷新未完成，请检查网络后重试'); }
    finally { inFlight.current = false; if (alive.current) setRefreshing(false); }
  }, [api]);
  return { state, error, refreshing, refresh };
}
