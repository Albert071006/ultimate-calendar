import { useCallback, useEffect, useState } from "react";
import type {
  ApiResult,
  ApiError,
  MutationInput,
  MutationResult,
  Snapshot,
} from "../../shared/contracts";
import type { HostCapabilities, PlannerClient } from "../../shared/client";
import { operationId } from "../calendar-layout";
export function usePlanner(api: PlannerClient | undefined, host?: HostCapabilities) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<ApiError["code"] | null>(null);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Extract<
    MutationResult,
    { status: "preview" }
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!api) return;
    const result = await api.snapshot();
    if (result.ok) setSnapshot(result.data);
    else {
      setError(result.error.message);
      setErrorCode(result.error.code);
    }
  }, [api]);
  useEffect(() => {
    if (!api) return;
    void refresh().catch(() => setError("本地服务连接失败，请重试。"));
    return api.onChanged(() => {
      void refresh().catch(() => setError("刷新失败，请重试。"));
    });
  }, [api, refresh]);
  const receive = useCallback((result: MutationResult) => {
    if (result.status === "preview") {
      setPreview(result);
      setNotice("尚未执行 · 请确认更改");
    } else if (result.status === "clarification") {
      setErrorCode(null);
      setNotice("尚未执行 · 需要补充信息");
      setError(result.questions.join("；"));
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
    setErrorCode(null);
    try {
      const result = await job();
      if (!result.ok) {
        setError(result.error.message);
        setErrorCode(result.error.code);
        return undefined;
      }
      success?.(result.data);
      await refresh();
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
