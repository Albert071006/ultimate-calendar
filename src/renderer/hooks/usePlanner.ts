import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiResult,
  ApiError,
  MutationInput,
  MutationResult,
  Snapshot,
} from "../../shared/contracts";
import type { HostCapabilities, PlannerClient, PlannerMutationResult } from "../../shared/client";
import { operationId } from "../calendar-layout";
import { applyPlannerPatch } from '../../shared/planner-sync';
type PlannerError = { message: string; code: ApiError["code"] | null };
type PendingOperation = { id: string; targets: string[]; label: string; status: 'submitting' | 'refreshing' | 'uncertain' };
type RunOptions = { targets?: string[]; label?: string };
function mutationTargets(mutations: MutationInput[], snapshot: Snapshot | null): string[] {
  const targets = new Set<string>();
  for (const mutation of mutations) {
    if (!('id' in mutation)) continue;
    const kind = 'entity' in mutation ? mutation.entity : /Candidate/.test(mutation.type) ? 'candidate' : /Block|RecurringEvent/.test(mutation.type) ? 'block' : /Task/.test(mutation.type) ? 'task' : undefined;
    if (kind) targets.add(`${kind}:${mutation.id}`);
    const taskId = kind === 'task' ? mutation.id : kind === 'candidate' ? snapshot?.candidates.find(value => value.id === mutation.id)?.taskId : kind === 'block' ? snapshot?.blocks.find(value => value.id === mutation.id)?.taskId : null;
    if (taskId) {
      targets.add(`task:${taskId}`);
      for (const block of snapshot?.blocks ?? []) if (block.taskId === taskId) targets.add(`block:${block.id}`);
      for (const candidate of snapshot?.candidates ?? []) if (candidate.taskId === taskId) targets.add(`candidate:${candidate.id}`);
    }
  }
  return [...targets];
}
export function usePlanner(api: PlannerClient | undefined, host?: HostCapabilities) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const pendingRef = useRef<PendingOperation[]>([]);
  const [pendingOperations, setPendingOperations] = useState<PendingOperation[]>([]);
  const publishPending = () => setPendingOperations([...pendingRef.current]);
  const isPending = (target?: string | string[]) => pendingOperations.some(operation => operation.status !== 'uncertain' && (!target || operation.targets.includes('*') || (Array.isArray(target) ? target : [target]).some(value => operation.targets.includes(value))));
  // A successful read only resolves a read failure, never an unconfirmed action.
  const [readError, setReadError] = useState<PlannerError | null>(null);
  const [actionError, setActionError] = useState<PlannerError | null>(null);
  const snapshotRequest = useRef(0);
  const settledSnapshotRequest = useRef(0);
  const activeOperations = useRef(0);
  const changedDuringOperation = useRef(false);
  const visibleError = actionError ?? readError;
  const error = visibleError?.message ?? "";
  const errorCode = visibleError?.code ?? null;
  const setError = useCallback((message: string) => {
    setActionError(message ? { message, code: null } : null);
    if (!message) setReadError(null);
  }, []);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Extract<
    MutationResult,
    { status: "preview" }
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const readSnapshot = useCallback(async (afterOperation = false, forceFull = false) => {
    if (!api) return;
    const request = ++snapshotRequest.current;
    // A pre-write read cannot supply or overwrite the authoritative post-write refresh.
    if (afterOperation) settledSnapshotRequest.current = request;
    let result: ApiResult<Snapshot>;
    try {
      const base = snapshotRef.current;
      if (!forceFull && base?.cursor && api.changes) {
        const delta = await api.changes({ cursor: base.cursor });
        if (!delta.ok) result = delta;
        else {
          const next = delta.data.status === 'patch' && snapshotRef.current ? applyPlannerPatch(snapshotRef.current, delta.data.patch) : null;
          result = next ? { ok: true, data: next } : await api.snapshot();
        }
      } else result = await api.snapshot();
    }
    catch (e) {
      result = { ok: false, error: { code: 'NETWORK', message: e instanceof Error ? e.message : '资料读取失败，请检查连接后重试。', retryable: true } };
    }
    // Late responses must not replace newer data or resurrect a recovered error.
    if (request < settledSnapshotRequest.current) return;
    settledSnapshotRequest.current = request;
    if (result.ok) { snapshotRef.current = result.data; setSnapshot(result.data); setReadError(null); }
    else setReadError({ code: result.error.code, message: afterOperation
      ? `已收到处理结果，但最新资料刷新失败：${result.error.message}。请刷新核对，不要重复提交。`
      : result.error.message });
  }, [api]);
  const refresh = useCallback(async () => { await readSnapshot(); }, [readSnapshot]);
  useEffect(() => {
    if (!api) return;
    void refresh();
    const unsubscribe = api.onChanged(event => {
      if (event?.domains && !event.domains.includes('planner') && !event.domains.includes('key')) return;
      if (event?.reason === 'key') { void readSnapshot(false, true); return; }
      const cursor = snapshotRef.current?.cursor;
      if (event?.cursor && cursor?.streamId === event.cursor.streamId && cursor.revision >= event.cursor.revision) return;
      // The native host notifies before returning a write receipt. Its notification
      // and run() must share one fresh read, rather than downloading the snapshot twice.
      if (activeOperations.current > 0) { changedDuringOperation.current = true; return; }
      void refresh();
    });
    return () => { unsubscribe(); settledSnapshotRequest.current = ++snapshotRequest.current; };
  }, [api, refresh, readSnapshot]);
  const receive = useCallback((result: PlannerMutationResult) => {
    if (result.status === "preview") {
      setPreview(result);
      setNotice("尚未执行 · 请确认更改");
    } else if (result.status === "clarification") {
      setNotice("尚未执行 · 需要补充信息");
      setActionError({ message: result.questions.join("；"), code: null });
    } else {
      setPreview(null);
      setNotice(result.message);
    }
  }, []);
  async function run<T>(
    job: () => Promise<ApiResult<T>>,
    success?: (data: T) => void,
    options: RunOptions = {},
  ): Promise<T | undefined> {
    const targets = options.targets ?? [];
    if (targets.length && pendingRef.current.some(operation => operation.status !== 'uncertain' && operation.targets.some(value => targets.includes(value)))) return undefined;
    const operation: PendingOperation = { id: operationId(), targets, label: options.label ?? '正在保存', status: 'submitting' };
    pendingRef.current = [...pendingRef.current.filter(value => value.status !== 'uncertain' || !value.targets.some(target => targets.includes(target))), operation]; publishPending();
    activeOperations.current += 1;
    setBusy(true);
    setError("");
    try {
      const result = await job();
      if (!result.ok) {
        setActionError({ message: result.error.message, code: result.error.code });
        if (result.error.code === 'NETWORK' && result.error.delivery !== 'not-sent') { operation.status = 'uncertain'; operation.label = '结果尚未确认，请核对原操作'; publishPending(); }
        return undefined;
      }
      success?.(result.data);
      // A confirmed operation stays confirmed even when the subsequent snapshot cannot be read.
      // Returning undefined here would expose a retry button for work that already succeeded.
      changedDuringOperation.current = false;
      let applied = api?.currentSnapshot?.() ?? null;
      try { applied ??= result.sync && snapshotRef.current ? applyPlannerPatch(snapshotRef.current, result.sync) : null; }
      catch { /* A confirmed write stays confirmed even if its patch requires a fresh canonical read. */ }
      if (applied) {
        settledSnapshotRequest.current = ++snapshotRequest.current;
        snapshotRef.current = applied; setSnapshot(applied); setReadError(null);
      } else {
        operation.status = 'refreshing'; operation.label = '已收到结果，正在更新'; publishPending();
        await readSnapshot(true);
      }
      return result.data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
      return undefined;
    } finally {
      pendingRef.current = pendingRef.current.filter(value => value.id !== operation.id || value.status === 'uncertain'); publishPending();
      activeOperations.current -= 1;
      if (activeOperations.current === 0) {
        setBusy(false);
        // Changes received after the post-write read began may be newer than it.
        // Preserve them, including notifications received before a failed operation.
        if (changedDuringOperation.current) {
          changedDuringOperation.current = false;
          void refresh();
        }
      }
    }
  }
  async function mutate(mutations: MutationInput[]) {
    if (!api) return;
    return run(
      () =>
        api.mutate({
          operationId: operationId(),
          origin: "manual",
          confirmed: false,
          mutations,
        }),
      receive,
      { targets: mutationTargets(mutations, snapshotRef.current), label: '正在保存' },
    );
  }
  async function confirm() {
    if (!api || !preview) return;
    await run(
      () =>
        api.mutate({
          ...preview.proposedRequest,
          origin: "manual",
          confirmed: true,
          confirmationToken: preview.confirmationToken,
        }),
      receive,
      { targets: mutationTargets(preview.proposedRequest.mutations, snapshotRef.current), label: '正在确认' },
    );
  }
  async function undo(id?: string) {
    if (api) await run(() => api.undo(id), receive, { targets: ['undo'], label: '正在撤销' });
  }
  return {
    client: api,
    host,
    snapshot,
    error,
    errorCode,
    setError,
    notice,
    setNotice,
    busy,
    isPending,
    pendingOperations,
    refresh,
    run,
    mutate,
    receive,
    preview,
    confirm,
    cancelPreview: () => {
      setPreview(null);
      setNotice("已取消，未执行更改");
    },
    undo,
  };
}
export type PlannerUI = ReturnType<typeof usePlanner>;
