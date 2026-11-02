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
type PlannerError = { message: string; code: ApiError["code"] | null };
export function usePlanner(api: PlannerClient | undefined, host?: HostCapabilities) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // A successful read only resolves a read failure, never an unconfirmed action.
  const [readError, setReadError] = useState<PlannerError | null>(null);
  const [actionError, setActionError] = useState<PlannerError | null>(null);
  const snapshotRequest = useRef(0);
  const settledSnapshotRequest = useRef(0);
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
  const readSnapshot = useCallback(async (afterOperation = false) => {
    if (!api) return;
    const request = ++snapshotRequest.current;
    let result: ApiResult<Snapshot>;
    try { result = await api.snapshot(); }
    catch (e) {
      result = { ok: false, error: { code: 'NETWORK', message: e instanceof Error ? e.message : '资料读取失败，请检查连接后重试。', retryable: true } };
    }
    // Late responses must not replace newer data or resurrect a recovered error.
    if (request < settledSnapshotRequest.current) return;
    settledSnapshotRequest.current = request;
    if (result.ok) { setSnapshot(result.data); setReadError(null); }
    else setReadError({ code: result.error.code, message: afterOperation
      ? `已收到处理结果，但最新资料刷新失败：${result.error.message}。请刷新核对，不要重复提交。`
      : result.error.message });
  }, [api]);
  const refresh = useCallback(async () => { await readSnapshot(); }, [readSnapshot]);
  useEffect(() => {
    if (!api) return;
    void refresh();
    const unsubscribe = api.onChanged(() => {
      void refresh();
    });
    return () => { unsubscribe(); settledSnapshotRequest.current = ++snapshotRequest.current; };
  }, [api, refresh]);
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
  ): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      const result = await job();
      if (!result.ok) {
        setActionError({ message: result.error.message, code: result.error.code });
        return undefined;
      }
      success?.(result.data);
      // A confirmed operation stays confirmed even when the subsequent snapshot cannot be read.
      // Returning undefined here would expose a retry button for work that already succeeded.
      await readSnapshot(true);
      return result.data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
      return undefined;
    } finally {
      setBusy(false);
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
    );
  }
  async function undo(id?: string) {
    if (api) await run(() => api.undo(id), receive);
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
