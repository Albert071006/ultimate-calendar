import { useId, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import type { Candidate, Snapshot } from "../../../shared/contracts";
import { candidateDisplay, compactCandidateText } from "../../candidate-display";
import { candidateExpiry } from "../../../domain/candidate-eligibility";
import { displayInstant } from "../../calendar-layout";
import { dayWord, fullDay } from "./format";
import { sourceLine } from "./InboxList";
import { useMobile } from '../../mobile/layout';

/** Marks every time phrase the extraction relied on inside the original text. */
export function highlight(text: string, quotes: string[]): ReactNode[] {
  const marks: { start: number; end: number }[] = [];
  for (const quote of [...new Set(quotes.map(value => value.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)) {
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + quote.length)) {
      if (!marks.some(mark => at < mark.end && at + quote.length > mark.start)) marks.push({ start: at, end: at + quote.length });
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) parts.push(text.slice(cursor, mark.start));
    parts.push(<mark key={mark.start}>{text.slice(mark.start, mark.end)}</mark>);
    cursor = mark.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export type Decision = "acceptCandidate" | "ignoreCandidate";

function FactContent({ summary, full, label }: { summary: ReactNode; full?: ReactNode; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <>
    <div className="v">{summary}</div>
    {full && <>
      <button type="button" className="a2-ib-fact-toggle" aria-expanded={expanded} aria-controls={id}
        onKeyDown={event => {
          if (!event.ctrlKey && !event.metaKey && !event.altKey && ['a', 'i', 'l', 'arrowup', 'arrowdown'].includes(event.key.toLowerCase())) event.stopPropagation();
        }} onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}{label}</button>
      {expanded && <div id={id} className="a2-ib-fact-full" role="region" aria-label={label}>{full}</div>}
    </>}
  </>;
}

export function CandidateDetail({ snapshot, candidate, today, now, busy, reason, setReason, decide, snoozing, setSnoozing, snooze, restore, edit, openSource, viewTask, viewCandidate, hideQQOriginal = false, clearedPhoneInput = false, localSourceAccess = false }: {
  snapshot: Snapshot;
  candidate: Candidate;
  today: string;
  now: number;
  busy: boolean;
  reason: string;
  setReason: (value: string) => void;
  decide: (type: Decision) => void;
  snoozing: boolean;
  setSnoozing: (value: boolean) => void;
  snooze: (until: string) => void;
  restore: () => void;
  edit: () => void;
  openSource: (id: string) => void;
  viewTask: (id: string) => void;
  viewCandidate: (id: string) => void;
  hideQQOriginal?: boolean;
  localSourceAccess?: boolean;
  clearedPhoneInput?: boolean;
}) {
  const mobile = useMobile();
  const hideRawInput = hideQQOriginal || clearedPhoneInput;
  const defaultUntil = now < Date.parse(`${today}T18:00:00+08:00`) ? `${today}T18:00` : `${new Date(Date.parse(`${today}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)}T09:00`;
  const [until, setUntil] = useState(defaultUntil);
  const display = candidateDisplay(candidate, snapshot.settings), expiry = candidateExpiry(candidate, now);
  const source = sourceLine(snapshot, candidate, today, mobile ? '来源原件未提供' : undefined);
  const old = snapshot.candidates.find(value => value.id === candidate.revisionOfId);
  const duplicate = snapshot.candidates.find(value => value.id === candidate.duplicateOfId);
  const merged = snapshot.candidates.filter(value => value.duplicateOfId === candidate.id).length;
  const evidence = (field: "deadline" | "eventStart" | "eventEnd") => candidate.temporalEvidence.find(item => item.field === field && item.quote);
  const open = candidate.status === "pending" && !expiry.expired;
  const snoozed = open && candidate.snoozedUntil && Date.parse(candidate.snoozedUntil) > now;
  const stated = candidate.benefitKind === "stated" && candidate.benefit;
  const guessed = candidate.potentialBenefit || (candidate.benefitKind === "inferred" ? candidate.benefit : "");
  const actionSummary = compactCandidateText(candidate.action, candidate.title);
  const statedSummary = stated ? compactCandidateText(stated) : '';
  const guessedSummary = compactCandidateText(guessed);
  const benefits = (short: boolean) => <>
    {stated && <p>{short ? statedSummary : stated}<span className="tag">原文写明</span></p>}
    {guessed && <p>{short ? guessedSummary : guessed}<span className="tag">AI 推测</span></p>}
    {!stated && !guessed && "未说明"}
  </>;
  return (
    <article className="a2-ib-detail" aria-label="通知详情" data-candidate-id={candidate.id}>
      <div className="src">
        {[source.label, source.at, merged ? `另有 ${merged} 条重复通知已合并` : "", candidate.revisionOfId ? "事项变更" : "", candidate.duplicateOfId ? "关联重复通知" : ""].filter(Boolean).join(" · ")}
        <button className={mobile ? "m-link" : "ui-btn sm ghost"} onClick={edit}>校对</button>
      </div>
      <h2>{candidate.title}</h2>
      {expiry.expired && candidate.status === "pending" && <div className="a2-ib-note warn"><strong>已过期 · 自动归类</strong><p>{expiry.reason}</p><p>按北京时间与明确时间依据归类，不代表你选择了忽略；时间有误可校对后自动回到待判断。</p></div>}
      {snoozed && <div className="a2-ib-note">稍后决定 · {dayWord(candidate.snoozedUntil!.slice(0, 10), today)} {candidate.snoozedUntil!.slice(11, 16)} 回到待判断</div>}
      <div className="a2-ib-facts">
        <div><div className="k">要做什么</div><FactContent label="行动详情" summary={actionSummary || "原文未明确，请校对"}
          full={actionSummary !== candidate.action.trim() ? candidate.action : undefined} /></div>
        <div><div className="k">能得到什么</div><FactContent label="收益详情" summary={benefits(true)}
          full={statedSummary !== (stated || '').trim() || guessedSummary !== guessed.trim() ? benefits(false) : undefined} /></div>
      </div>
      <section className="a2-ib-times" aria-label="事项时间">
        <div>
          <div className="k">截止</div>
          <div className={`v${candidate.deadline ? " red" : " none"}`}>{candidate.deadline ? `${fullDay(candidate.deadline.date)} ${candidate.deadline.time ?? "· 当天结束"}` : "未提供"}</div>
          {!hideRawInput && evidence("deadline") && <div className="q">原文“{evidence("deadline")!.quote}”</div>}
        </div>
        <div>
          <div className="k">活动时间</div>
          <div className={`v${candidate.eventStart ? "" : " none"}`}>{candidate.eventStart
            ? `${fullDay(candidate.eventStart.slice(0, 10))} ${candidate.eventStart.slice(11, 16)}${candidate.eventEnd ? `–${candidate.eventEnd.slice(0, 10) === candidate.eventStart.slice(0, 10) ? "" : `${fullDay(candidate.eventEnd.slice(0, 10))} `}${candidate.eventEnd.slice(11, 16)}` : " 起"}`
            : "未明确"}</div>
          {!hideRawInput && (evidence("eventStart") ?? evidence("eventEnd")) && <div className="q">原文“{(evidence("eventStart") ?? evidence("eventEnd"))!.quote}”</div>}
          {candidate.eventStart && !candidate.eventEnd && <div className="q">结束时间未提供</div>}
        </div>
        <div>
          <div className="k">地点</div>
          <div className={`v place${candidate.location ? "" : " none"}`}>{candidate.location || "未说明"}</div>
        </div>
        {display.timeNotes.length > 0 && <div className="notes"><div className="k">原文时间补充</div>{display.timeNotes.map((note, index) => <p key={index}>{note}</p>)}</div>}
        {!expiry.expired && expiry.reason && <p className="warning">{expiry.reason}</p>}
      </section>
      {display.conditions.length > 0 && <><p className="a2-ib-sub">参加资格与准备</p><ul className="a2-ib-plain">{display.conditions.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
      {localSourceAccess && hideRawInput ? null : hideQQOriginal ? <p className="a2-ib-note">QQ 原文和附件仅在采集电脑保存，目前无法在手机查看。手机只显示提炼结果。</p> : clearedPhoneInput ? <p className="a2-ib-note">手机导入的分析输入已清理，提炼事项仍保留。</p> : candidate.sourceQuote && <><p className="a2-ib-sub">原文</p><blockquote className="a2-ib-quote">{highlight(candidate.sourceQuote, candidate.temporalEvidence.map(item => item.quote))}</blockquote></>}
      {display.uncertainties.length > 0 && <><p className="a2-ib-sub">待确认</p><ul className="a2-ib-plain">{display.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
      {old && <div className="a2-ib-note">
        <strong>原事项 → 本次变更</strong>
        <p>{old.title} · {old.deadline?.date ?? "无截止"} → {candidate.title} · {candidate.deadline?.date ?? "无截止"}</p>
        <p>活动 {displayInstant(old.eventStart)} → {displayInstant(candidate.eventStart)}</p>
        <p>接受后先预览关联任务的修改。<button className="ui-btn sm ghost" onClick={() => viewCandidate(old.id)}>查看原事项</button></p>
      </div>}
      {duplicate && <div className="a2-ib-note warn">
        <p>关联通知：{duplicate.title}。请先接受原事项，再接受本通知以关联同一任务。</p>
        <button className="ui-btn sm" onClick={() => viewCandidate(duplicate.id)}>查看关联原事项</button>
      </div>}
      <div className="a2-ib-sources">
        {candidate.sourceIds.map(id => {
          const value = snapshot.sources.find(item => item.id === id);
          return value ? <button className="ui-btn sm" key={id} aria-label={`查看来源 · ${value.label || "原文"}`} onClick={() => openSource(id)}><FileText aria-hidden="true" />查看来源<span className="from">{value.label || "原文"}</span></button> : <span key={id}>{mobile ? '来源原件未提供；QQ 原文和附件留在采集电脑' : '原文已删除'}</span>;
        })}
        {localSourceAccess && hideRawInput && <span className="hint">{hideQQOriginal ? '原文和附件只存在这台电脑，不上传云端' : '可在来源里查找这台电脑保留的原始输入'}</span>}
      </div>
      <div className="a2-ib-decide">
        {open && !snoozing && <>
          <button className="ui-btn primary" disabled={busy} aria-label="接受事项" onClick={() => decide("acceptCandidate")}>{old ? "审阅并接受变更" : "接受"}{!mobile && <> <kbd>A</kbd></>}</button>
          <button className={mobile ? "m-text-btn quiet" : "ui-btn"} disabled={busy} onClick={() => decide("ignoreCandidate")}>忽略{!mobile && <> <kbd>I</kbd></>}</button>
          <button className={mobile ? "m-text-btn quiet" : "ui-btn"} disabled={busy} onClick={() => setSnoozing(true)}>稍后{!mobile && <> <kbd>L</kbd></>}</button>
          <input aria-label="决定原因（可选）" value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} placeholder={mobile ? "原因（可选）" : "原因（可选），例如：时间冲突、没兴趣"} />
        </>}
        {open && snoozing && <form className="a2-ib-snooze" onSubmit={event => { event.preventDefault(); snooze(`${until}:00+08:00`); setSnoozing(false); }}>
          <label>再次查看时间<input type="datetime-local" required value={until} onChange={event => setUntil(event.target.value)} autoFocus /></label>
          <button type="submit" className="ui-btn primary" disabled={busy}>稍后再看</button>
          <button type="button" className="ui-btn ghost" onClick={() => setSnoozing(false)}>取消</button>
        </form>}
        {candidate.status === "pending" && expiry.expired && <button className="ui-btn" onClick={edit}>校对时间与状态</button>}
        {candidate.status === "ignored" && <button className="ui-btn" disabled={busy} onClick={restore}>恢复待判断</button>}
        {candidate.status === "accepted" && <span className="a2-ib-done">已建立独立任务{candidate.taskId && <button className="ui-btn sm" onClick={() => viewTask(candidate.taskId!)}>查看任务</button>}</span>}
      </div>
    </article>
  );
}
