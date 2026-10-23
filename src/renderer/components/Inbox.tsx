import { useState } from "react";
import type { Candidate, Snapshot } from "../../shared/contracts";
import type { PlannerUI } from "../hooks/usePlanner";
import { displayInstant, todayDate } from "../calendar-layout";
import type { Selection } from "./Calendar";
import { candidateDisposition, candidateExpiry } from '../../domain/candidate-eligibility';
import { useCurrentTime } from '../hooks/useCurrentTime';
import { candidateDisplay } from '../candidate-display';
import { CandidateTiming } from './CandidateTiming';
export function Inbox({
  snapshot,
  ui,
  select,
  edit,
  importMessage,
  openSource,
}: {
  snapshot: Snapshot;
  ui: PlannerUI;
  select: (s: Selection) => void;
  edit: (id: string) => void;
  importMessage: () => void;
  openSource: (id: string) => void;
}) {
  const [tab, setTab] = useState("pending"),
    [reason, setReason] = useState(""),
    [snooze, setSnooze] = useState<Candidate | null>(null),
    [until, setUntil] = useState(`${todayDate()}T18:00`);
  const now = useCurrentTime();
  const candidates = snapshot.candidates.filter(c => candidateDisposition(c, now) === tab);
  return (
    <div className="page-scroll">
      <div className="section-heading">
        <div>
          <h2>先看清，再决定</h2>
          <p>先看时间，再决定是否行动。明确过期的通知会保留在“已过期”中。</p>
        </div>
        <button className="primary" onClick={importMessage}>
          ＋ 导入消息
        </button>
      </div>
      <div className="tabs">
        {[
          ["pending", "待判断"],
          ["snoozed", "稍后决定"],
          ["expired", "已过期"],
          ["accepted", "已接受"],
          ["ignored", "已忽略"],
          ["sources", "导入记录"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "sources" ? (
        <div className="source-list">
          {snapshot.sources.length ? (
            snapshot.sources.toReversed().map((s) => (
              <button
                className="source-row"
                key={s.id}
                onClick={() => openSource(s.id)}
              >
                <span>{s.kind === "image" ? "▧" : "≡"}</span>
                <div>
                  <strong>
                    {s.label || "未命名来源"}{" "}
                    {s.purpose === "courses" && "· 课表"}
                  </strong>
                  <small>
                    {displayInstant(s.importedAt)} ·{" "}
                    {
                      {
                        saved: "已保存，待分析",
                        processing: "处理中",
                        failed: "分析失败",
                        succeeded: "分析完成",
                        "needs-review": "需要校对",
                      }[s.status]
                    }
                  </small>
                  {s.error && <small className="error">{s.error}</small>}
                </div>
                <span>查看原文 →</span>
              </button>
            ))
          ) : (
            <div className="empty-state">尚未导入消息或截图。</div>
          )}
        </div>
      ) : (
        <>
          {tab !== 'expired' && <label className="decision-reason">
            决定原因（可选）
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="记录明确反馈，不会自动推测你的偏好"
              maxLength={2000}
            />
          </label>}
          {tab === 'expired' && <p className="hint">按北京时间与明确时间依据归类，不代表你选择了忽略。原文、附件来源和已有决定均保留；时间有误可校对后自动回到待判断。</p>}
          {!candidates.length && (
            <div className="empty-state">
              <h3>{tab === "pending" ? "待判断清空了" : "这里还没有事项"}</h3>
              <p>粘贴消息或导入截图，原文始终可以核对。</p>
              <button onClick={importMessage}>导入一条消息</button>
            </div>
          )}
          <div className="candidate-grid">
            {candidates.map((c) => {
              const presentation = candidateDisplay(c, snapshot.settings), expiry = candidateExpiry(c, now);
              const old = snapshot.candidates.find(
                  (v) => v.id === c.revisionOfId,
                ),
                duplicate = snapshot.candidates.find(
                  (v) => v.id === c.duplicateOfId,
                );
              return (
                <article className={`candidate-card${tab === 'expired' ? ' is-expired' : ''}`} key={c.id}>
                  <div className="candidate-actions">
                    {tab === 'expired' ? <button onClick={() => edit(c.id)}>校对时间与状态</button> : c.status === "pending" ? (
                      <>
                        <button
                          className="primary"
                          disabled={ui.busy}
                          aria-label="接受事项"
                          onClick={() =>
                            void ui.mutate([
                              {
                                type: "acceptCandidate",
                                id: c.id,
                                expectedVersion: c.version,
                                reason,
                              },
                            ])
                          }
                        >
                          {old ? "审阅并接受变更" : "接受"}
                        </button>
                        <button
                          disabled={ui.busy}
                          onClick={() =>
                            void ui.mutate([
                              {
                                type: "ignoreCandidate",
                                id: c.id,
                                expectedVersion: c.version,
                                reason,
                              },
                            ])
                          }
                        >
                          忽略
                        </button>
                        <button onClick={() => setSnooze(c)}>稍后决定</button>
                      </>
                    ) : c.status === "ignored" ? (
                      <button
                        onClick={() =>
                          void ui.mutate([
                            {
                              type: "restoreCandidate",
                              id: c.id,
                              expectedVersion: c.version,
                              reason,
                            },
                          ])
                        }
                      >
                        恢复待判断
                      </button>
                    ) : (
                      <span className="success">
                        已建立独立任务
                        {c.taskId && (
                          <button
                            onClick={() =>
                              select({ entity: "task", id: c.taskId! })
                            }
                          >
                            查看任务
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="card-top">
                    <span className="eyebrow">
                      {c.revisionOfId
                        ? "事项变更"
                        : c.duplicateOfId
                          ? "关联重复通知"
                          : "候选事项"}
                    </span>
                    <button onClick={() => edit(c.id)}>校对</button>
                  </div>
                  <button
                    className="title-button"
                    onClick={() => select({ entity: "candidate", id: c.id })}
                  >
                    <h3>{c.title}</h3>
                  </button>
                  <CandidateTiming candidate={c} />
                  {tab === 'expired' && <div className="candidate-expiry"><strong>已过期 · 自动归类</strong><p>{expiry.reason}</p></div>}
                  {c.location && <p className="candidate-location">地点 · {c.location}</p>}
                  <dl>
                    <dt>需要做</dt>
                    <dd>{c.action || "原文未明确，请校对"}</dd>
                    <dt>原文收益</dt>
                    <dd>
                      {c.benefitKind === "stated"
                        ? c.benefit || "未说明"
                        : "未说明"}
                    </dd>
                    {(c.potentialBenefit || c.benefitKind === "inferred") && (
                      <>
                        <dt>潜在收益 · 推测</dt>
                        <dd>{c.potentialBenefit || c.benefit}</dd>
                      </>
                    )}
                    {presentation.conditions.length > 0 && (
                      <>
                        <dt>参加资格与准备</dt>
                        <dd>{presentation.conditions.join("；")}</dd>
                      </>
                    )}
                  </dl>
                  {presentation.uncertainties.length > 0 && (
                    <div className="uncertainties">
                      <strong>需要确认</strong>
                      {presentation.uncertainties.map((u, i) => (
                        <p key={i}>{u}</p>
                      ))}
                    </div>
                  )}
                  {c.sourceQuote && <blockquote>{c.sourceQuote}</blockquote>}
                  {c.temporalEvidence.map((e, i) => (
                    <p className="fine-print" key={i}>
                      {
                        {
                          deadline: "截止依据",
                          eventStart: "活动开始依据",
                          eventEnd: "活动结束依据",
                        }[e.field]
                      }{" "}
                      ·{" "}
                      {
                        {
                          explicit: "明确时间",
                          relative: "相对时间",
                          unknown: "时间未明",
                        }[e.basis]
                      }
                      ：{e.quote}
                    </p>
                  ))}
                  {old && (
                    <div className="revision">
                      <strong>原事项 → 本次变更</strong>
                      <p>
                        {old.title} · {old.deadline?.date ?? "无截止"} →{" "}
                        {c.title} · {c.deadline?.date ?? "无截止"}
                      </p>
                      <p>
                        活动 {displayInstant(old.eventStart)} →{" "}
                        {displayInstant(c.eventStart)}
                      </p>
                      <button
                        onClick={() =>
                          select({ entity: "candidate", id: old.id })
                        }
                      >
                        查看原事项
                      </button>
                      <small>接受后先预览关联任务的修改。</small>
                    </div>
                  )}
                  {duplicate && (
                    <div className="warning">
                      <p>
                        关联通知：{duplicate.title}
                        。请先接受原事项，再接受本通知以关联同一任务。
                      </p>
                      <button
                        onClick={() =>
                          select({ entity: "candidate", id: duplicate.id })
                        }
                      >
                        查看关联原事项
                      </button>
                    </div>
                  )}
                  <div className="source-links">
                    {c.sourceIds.map((id) => {
                      const source = snapshot.sources.find((s) => s.id === id);
                      return source ? (
                        <button key={id} onClick={() => openSource(id)}>
                          查看来源 · {source.label || "原文"}
                        </button>
                      ) : <span key={id}>原文已删除</span>;
                    })}
                  </div>

                </article>
              );
            })}
          </div>
        </>
      )}
      {snooze && (
        <form
          className="snooze-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void ui
              .mutate([
                {
                  type: "snoozeCandidate",
                  id: snooze.id,
                  expectedVersion: snooze.version,
                  until: `${until}:00+08:00`,
                  reason,
                },
              ])
              .then((r) => {
                if (r && r.status !== "clarification") setSnooze(null);
              });
          }}
        >
          <strong>稍后查看 · {snooze.title}</strong>
          <label>
            再次查看时间
            <input
              type="datetime-local"
              required
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </label>
          <button type="submit" className="primary">
            保存
          </button>
          <button type="button" onClick={() => setSnooze(null)}>
            取消
          </button>
        </form>
      )}
    </div>
  );
}
