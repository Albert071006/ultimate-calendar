import { useEffect, useRef, useState } from "react";
import { ChevronLeft, History, Import, Plus } from "lucide-react";
import type { Candidate, Snapshot } from "../../shared/contracts";
import type { CaptureSnapshot } from "../../shared/capture";
import type { HostCapabilities } from "../../shared/client";
import type { PlannerUI } from "../hooks/usePlanner";
import { displayInstant } from "../calendar-layout";
import type { Selection } from "./Calendar";
import { candidateDisposition } from '../../domain/candidate-eligibility';
import { useCurrentTime } from '../hooks/useCurrentTime';
import { PageToolbar } from "./shell/PageToolbar";
import { InboxList, type Toast } from "./inbox/InboxList";
import { CandidateDetail, type Decision } from "./inbox/CandidateDetail";
import { arrival, dayWord } from "./inbox/format";
import "./inbox/Inbox.css";
import { useMobile } from '../mobile/layout';
import { MobileSheet } from '../mobile/MobileSheet';
import type { ReactNode } from 'react';
import { isClearedPhoneSource, isExtractedQQSource } from '../source-presentation';

function DetailFrame({ mobile, close, children }: { mobile: boolean; close: () => void; children: ReactNode }) {
  return mobile ? <MobileSheet title="事项详情" close={close}>{children}</MobileSheet> : <>{children}</>;
}

type Tab = "pending" | "snoozed" | "done";
type DoneFilter = "all" | "accepted" | "ignored" | "expired";
const sourceStatus = { saved: "已保存，待分析", processing: "处理中", failed: "分析失败", succeeded: "分析完成", "needs-review": "需要校对" } as const;

/** QQ capture's last arrival and polling interval, when capture is set up on this computer. */
function useCaptureStatus(host: HostCapabilities | undefined) {
  const [status, setStatus] = useState<CaptureSnapshot | null>(null);
  useEffect(() => {
    if (!host?.captureSnapshot) return;
    let live = true;
    void host.captureSnapshot().then(result => { if (live && result.ok) setStatus(result.data); }).catch(() => {});
    const off = host.onCaptureChanged?.(snapshot => setStatus(snapshot));
    return () => { live = false; off?.(); };
  }, [host]);
  return status?.config.enabled ? status : null;
}

/**
 * 待判断: a list with quick ✓ / ✕ on every open notice and the selected notice's detail beside it.
 * Arrow keys move through the list; A, I and L accept, ignore or postpone the selected notice.
 */
export function Inbox({ snapshot, ui, select, edit, importMessage, openSource, focus, host }: {
  snapshot: Snapshot;
  ui: PlannerUI;
  select: (s: Selection) => void;
  edit: (id: string) => void;
  importMessage: () => void;
  openSource: (id: string) => void;
  /** A notice to show, e.g. one opened from the today page or a notification. */
  focus?: string | null;
  host?: HostCapabilities;
}) {
  const mobile = useMobile();
  const [detailOpen, setDetailOpen] = useState(Boolean(focus));
  const now = useCurrentTime();
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const [tab, setTab] = useState<Tab>("pending");
  const [doneFilter, setDoneFilter] = useState<DoneFilter>("all");
  const [sources, setSources] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focus ?? null);
  const [fallback, setFallback] = useState(0);
  const [reason, setReason] = useState("");
  const [snoozing, setSnoozing] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const capture = useCaptureStatus(host);

  const disposition = (candidate: Candidate) => candidateDisposition(candidate, now);
  const counts = { pending: 0, snoozed: 0, done: 0 };
  for (const candidate of snapshot.candidates) {
    const value = disposition(candidate);
    counts[value === "pending" ? "pending" : value === "snoozed" ? "snoozed" : "done"]++;
  }
  const items = snapshot.candidates.filter(candidate => {
    const value = disposition(candidate);
    return tab === "done" ? value !== "pending" && value !== "snoozed" && (doneFilter === "all" || value === doneFilter) : value === tab;
  });
  const current = items.find(candidate => candidate.id === selectedId) ?? items[Math.min(fallback, items.length - 1)];
  const quick = tab !== "done";

  useEffect(() => {
    if (!focus) return;
    setDetailOpen(true);
    const candidate = snapshot.candidates.find(value => value.id === focus);
    if (!candidate) return;
    const value = candidateDisposition(candidate, Date.now());
    setTab(value === "pending" || value === "snoozed" ? value : "done");
    if (value !== "pending" && value !== "snoozed") setDoneFilter("all");
    setSources(false);
    setSelectedId(focus);
    // Only a newly requested notice moves the page; later snapshot refreshes must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  useEffect(() => { setSnoozing(false); }, [current?.id]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const pick = (id: string) => { setSelectedId(id); setDetailOpen(true); setFallback(Math.max(0, items.findIndex(candidate => candidate.id === id))); };
  async function decide(candidate: Candidate, type: Decision) {
    const index = items.findIndex(value => value.id === candidate.id);
    const result = await ui.mutate([{ type, id: candidate.id, expectedVersion: candidate.version, reason }]);
    if (result?.status !== "applied") return;
    setDetailOpen(false);
    setReason("");
    setFallback(Math.max(0, index));
    if (selectedId === candidate.id) setSelectedId(null);
    setToast({ text: `${type === "acceptCandidate" ? "已接受" : "已忽略"}「${candidate.title}」`, transactionId: result.transactionId, id: candidate.id });
  }
  async function snooze(candidate: Candidate, until: string) {
    const index = items.findIndex(value => value.id === candidate.id);
    const result = await ui.mutate([{ type: "snoozeCandidate", id: candidate.id, expectedVersion: candidate.version, until, reason }]);
    if (result?.status !== "applied") return;
    setReason("");
    setFallback(Math.max(0, index));
    if (selectedId === candidate.id) setSelectedId(null);
    setToast({ text: `已推迟「${candidate.title}」`, transactionId: result.transactionId, id: candidate.id });
  }
  async function undo() {
    if (!toast) return;
    const { transactionId, id } = toast;
    setToast(null);
    await ui.undo(transactionId);
    setSelectedId(id);
  }

  const keys = useRef({ items, current, quick, busy: ui.busy, decide, setSnoozing, pick });
  keys.current = { items, current, quick, busy: ui.busy, decide, setSnoozing, pick };
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (target?.closest("input, textarea, select, [contenteditable=true]") || document.querySelector('[role="dialog"]')) return;
      const { items, current, quick, busy, decide, setSnoozing, pick } = keys.current;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!items.length) return;
        event.preventDefault();
        const index = current ? items.indexOf(current) : -1;
        const next = items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]!;
        pick(next.id);
        document.querySelector<HTMLElement>(`.a2-ib-item[data-candidate-id="${next.id}"]`)?.scrollIntoView?.({ block: "nearest" });
        return;
      }
      if (!current || !quick || busy) return;
      const key = event.key.toLowerCase();
      if (key === "a") { event.preventDefault(); void decide(current, "acceptCandidate"); }
      else if (key === "i") { event.preventDefault(); void decide(current, "ignoreCandidate"); }
      else if (key === "l") { event.preventDefault(); setSnoozing(true); }
    };
    document.addEventListener("keydown", press);
    return () => document.removeEventListener("keydown", press);
  }, []);

  const snoozedList = snapshot.candidates.filter(candidate => disposition(candidate) === "snoozed")
    .sort((a, b) => a.snoozedUntil!.localeCompare(b.snoozedUntil!));
  const tabs: [Tab, string, number | null][] = [["pending", "待判断", counts.pending], ["snoozed", "稍后", counts.snoozed], ["done", "已处理", null]];
  const switchTab = (id: Tab) => { setTab(id); setSelectedId(null); setFallback(0); };
  const doneFilters = [["all", "全部"], ["accepted", "已接受"], ["ignored", "已忽略"], ["expired", "已过期"]] as const;
  const detail = current && (!mobile || detailOpen) && <DetailFrame mobile={mobile} close={() => setDetailOpen(false)}><CandidateDetail key={current.id} snapshot={snapshot} candidate={current} today={today} now={now} busy={ui.busy}
    localSourceAccess={Boolean(host) && !mobile}
    hideQQOriginal={current.sourceIds.some(id => { const source = snapshot.sources.find(value => value.id === id); return source ? isExtractedQQSource(source) || ((mobile || !host) && Boolean(source.captureRef)) : mobile || !host; })}
    clearedPhoneInput={current.sourceIds.some(id => { const source = snapshot.sources.find(value => value.id === id); return source ? isClearedPhoneSource(source) : false; })}
    reason={reason} setReason={setReason} decide={type => void decide(current, type)}
    snoozing={snoozing} setSnoozing={setSnoozing} snooze={until => void snooze(current, until)}
    restore={() => void ui.mutate([{ type: "restoreCandidate", id: current.id, expectedVersion: current.version, reason }])}
    edit={() => edit(current.id)} openSource={openSource} viewTask={id => select({ entity: "task", id })} viewCandidate={id => {
      const target = snapshot.candidates.find(value => value.id === id);
      if (!target) return;
      const value = disposition(target);
      setTab(value === "pending" || value === "snoozed" ? value : "done");
      setDoneFilter("all");
      setSelectedId(id);
    }} /></DetailFrame>;
  const waiting = <>
    {capture && <>QQ 采集{capture.lastReceivedAt ? `上次收到消息 ${arrival(capture.lastReceivedAt, today)}` : "已开启"} · 每 {capture.config.intervalSeconds / 60} 分钟检查一次<br /></>}
    {snoozedList.length > 0 && `稍后决定的 ${snoozedList.length} 条，最早${dayWord(snoozedList[0]!.snoozedUntil!.slice(0, 10), today)} ${snoozedList[0]!.snoozedUntil!.slice(11, 16)} 回到这里。`}
  </>;

  // The phone page: a plain title with two icons, a segmented switch, quiet rows. Decisions show in the shared toast.
  if (mobile) return (
    <div className="m-page m-inbox">
      {sources ? <header className="m-subpage-head">
        <button className="m-link m-back" aria-label="返回待判断" onClick={() => setSources(false)}><ChevronLeft aria-hidden="true" />待判断</button>
        <div className="m-hero"><div><h1>导入记录</h1></div></div>
      </header> : <header className="m-hero">
        <div><h1>待判断</h1></div>
        <div className="m-hero-acts">
          <button className="m-icon" aria-label="导入记录" onClick={() => setSources(true)}><History aria-hidden="true" /></button>
          <button className="m-icon" aria-label="导入消息" onClick={importMessage}><Plus aria-hidden="true" /></button>
        </div>
      </header>}
      {sources ? (snapshot.sources.length ? <ul className="m-card" aria-label="导入记录">
        {snapshot.sources.toReversed().map(source => <li key={source.id}><button className="m-card-row" onClick={() => openSource(source.id)}>
          <span className="m-card-main">
            <b>{source.label || "未命名来源"}{source.purpose === "courses" && " · 课表"}</b>
            <small>{source.kind === "image" ? "截图" : "文字"} · {displayInstant(source.importedAt)} · {sourceStatus[source.status]}</small>
            {source.error && <small className="attn">{source.error}</small>}
          </span>
        </button></li>)}
      </ul> : <div className="m-ib-empty"><p className="title">还没有导入记录</p><p>粘贴群消息或导入截图后，原文会留在这里。</p></div>) : <>
        <div className="m-seg m-ib-tabs" role="tablist" aria-label="通知分类">
          {tabs.map(([id, label, count]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => switchTab(id)}>{label}{count ? ` ${count}` : ""}</button>)}
        </div>
        {tab === "done" && <div className="m-ib-filter" role="group" aria-label="已处理筛选">
          {doneFilters.map(([id, label]) => <button key={id} className="m-link" aria-pressed={doneFilter === id} onClick={() => { setDoneFilter(id); setSelectedId(null); setFallback(0); }}>{label}</button>)}
        </div>}
        {items.length ? <>
          <InboxList snapshot={snapshot} items={items} selectedId={current?.id} today={today} quick={quick} busy={ui.busy}
            select={pick} decide={(candidate, type) => void decide(candidate, type)} toast={null} undo={() => {}} />
          {detail}
        </> : <div className="m-ib-empty">
          <p className="title">{tab === "pending" ? "都处理完了" : tab === "snoozed" ? "没有稍后决定的通知" : "这里还没有事项"}</p>
          {tab === "pending" && (capture || snoozedList.length > 0) && <p>{waiting}</p>}
          {tab === "pending" && <button className="m-link" onClick={importMessage}>导入消息</button>}
        </div>}
      </>}
    </div>
  );
  return (
    <div className="a2-page a2-inbox">
      <PageToolbar title="待判断" ui={ui}>
        <button className={`ui-btn ghost${sources ? " on" : ""}`} aria-pressed={sources} onClick={() => setSources(value => !value)}><History aria-hidden="true" />导入记录</button>
        <button className="ui-btn primary" onClick={importMessage}><Import aria-hidden="true" />导入消息</button>
      </PageToolbar>
      {sources ? (
        <section className="a2-ib-sourcelist" aria-label="导入记录">
          {snapshot.sources.length ? snapshot.sources.toReversed().map(source => (
            <button className="a2-ib-source" key={source.id} onClick={() => openSource(source.id)}>
              <span className="kind">{source.kind === "image" ? "截图" : "文字"}</span>
              <span className="main">
                <strong>{source.label || "未命名来源"}{source.purpose === "courses" && " · 课表"}</strong>
                <small>{displayInstant(source.importedAt)} · {sourceStatus[source.status]}</small>
                {source.error && <small className="error">{source.error}</small>}
              </span>
              <span className="go">{host && !mobile ? '查看原文' : isExtractedQQSource(source) || (!host && source.captureRef) ? 'QQ 来源说明' : isClearedPhoneSource(source) ? '输入已清理' : '查看原文'}</span>
            </button>
          )) : <div className="ui-empty"><h4>还没有导入记录</h4><p>粘贴群消息或导入截图后，原文会保存在这里，随时可以核对。</p></div>}
        </section>
      ) : <>
        <div className="ui-tabs" role="tablist" aria-label="通知分类">
          {tabs.map(([id, label, count]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => switchTab(id)}>
              {label}{count !== null && <b>{count}</b>}
            </button>
          ))}
          {tab === "done" && <div className="ui-seg" role="group" aria-label="已处理筛选">
            {doneFilters.map(([id, label]) => (
              <button key={id} aria-pressed={doneFilter === id} onClick={() => { setDoneFilter(id); setSelectedId(null); setFallback(0); }}>{label}</button>
            ))}
          </div>}
        </div>
        {items.length ? (
          <div className="a2-ib-body">
            <InboxList snapshot={snapshot} items={items} selectedId={current?.id} today={today} quick={quick} busy={ui.busy}
              select={pick} decide={(candidate, type) => void decide(candidate, type)} toast={toast} undo={() => void undo()} />
            {detail}
          </div>
        ) : (
          <div className="a2-ib-empty">
            {toast && <div className="ui-toast a2-ib-toast" role="status">{toast.text}<button onClick={() => void undo()}>撤销</button></div>}
            {tab === "pending" ? <div className="ui-empty center">
              <h4>都处理完了</h4>
              {(capture || snoozedList.length > 0) && <p>{waiting}</p>}
              <div className="actions"><button className="ui-btn" onClick={importMessage}><Import aria-hidden="true" />导入消息</button></div>
            </div> : <div className="ui-empty center">
              <h4>{tab === "snoozed" ? "没有稍后决定的通知" : "这里还没有事项"}</h4>
              <p>{tab === "snoozed" ? "在通知上按 L 或点「稍后」，选个时间再看。" : "接受、忽略或已过期的通知会留在这里，原文始终可以核对。"}</p>
            </div>}
          </div>
        )}
      </>}
    </div>
  );
}
