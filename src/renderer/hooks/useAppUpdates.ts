import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostCapabilities } from '../../shared/client';
import type { UpdateState } from '../../shared/update';

type UpdateAction = 'check' | 'download' | 'install';
const activeStatuses = new Set<UpdateState['status']>(['checking', 'downloading', 'installing']);

/** Update notifications never refresh planner data or replace an in-progress form. */
export function useAppUpdates(api: HostCapabilities | undefined) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<UpdateAction | null>(null);
  const generation = useRef(0), revision = useRef(0), inFlight = useRef<symbol | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const supported = !!api && ['updateSnapshot', 'onUpdateChanged', 'checkForUpdates', 'downloadUpdate', 'installUpdate']
    .every(method => typeof api[method as keyof HostCapabilities] === 'function');

  useEffect(() => {
    const current = ++generation.current;
    setState(null); setError(''); setPending(null); inFlight.current = null;
    if (!supported || !api) return;
    const receive = (next: UpdateState) => {
      if (current !== generation.current) return;
      revision.current++;
      stateRef.current = next;
      setState(next); setError('');
    };
    const unsubscribe = api.onUpdateChanged(receive);
    const start = revision.current;
    void api.updateSnapshot().then(result => {
      if (current !== generation.current || start !== revision.current) return;
      if (result.ok) { stateRef.current = result.data; setState(result.data); }
      else setError(result.error.message);
    }).catch(() => {
      if (current === generation.current && start === revision.current) setError('暂时无法读取更新状态，请重试。');
    });
    return () => { generation.current++; unsubscribe(); };
  }, [api, supported]);

  const run = useCallback(async (action: UpdateAction) => {
    if (!api || !supported || inFlight.current || (stateRef.current && activeStatuses.has(stateRef.current.status))) return false;
    const token = Symbol(action), current = generation.current, start = revision.current;
    inFlight.current = token; setPending(action); setError('');
    try {
      const result = await (action === 'check' ? api.checkForUpdates() : action === 'download' ? api.downloadUpdate() : api.installUpdate());
      if (current !== generation.current) return false;
      if (!result.ok) { setError(result.error.message); return false; }
      if (start === revision.current) { stateRef.current = result.data; setState(result.data); }
      return result.data.status !== 'error';
    } catch {
      if (current === generation.current) setError('更新操作未完成，请检查网络后重试。');
      return false;
    } finally {
      if (current === generation.current && inFlight.current === token) { inFlight.current = null; setPending(null); }
    }
  }, [api, supported]);

  return { state, error, pending, supported,
    busy: !!pending || !!(state && activeStatuses.has(state.status)),
    check: () => run('check'), download: () => run('download'), install: () => run('install'),
  };
}

export type AppUpdates = ReturnType<typeof useAppUpdates>;
