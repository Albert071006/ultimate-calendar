import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import type { CourseImportResult, DesktopAPI, Source } from "../shared/contracts";
import { buildCalendar } from "../domain/calendar";
import { todayDate } from "./calendar-layout";
import { usePlanner } from "./hooks/usePlanner";
import { isPendingCandidate } from '../domain/candidate-eligibility';
import { useCurrentTime } from './hooks/useCurrentTime';
import { useAppUpdates } from './hooks/useAppUpdates';
import { SoftwareUpdate, UpdateShortcut } from './components/SoftwareUpdate';
import { Sidebar, type Page } from "./components/Sidebar";
import {
  Calendar,
  type Selection,
  type ScheduleDraft,
} from "./components/Calendar";
import { Tasks } from "./components/Tasks";
import { Goals } from "./components/Goals";
import { Inbox } from "./components/Inbox";
import { Settings } from "./components/Settings";
import { CapturePage } from "./components/CapturePage";
import { LedgerPage } from "./components/LedgerPage";
import { CommandBar } from "./components/CommandBar";
import { CourseEditor } from "./components/CourseEditor";
import {
  DetailPanel,
  EntityEditor,
  type EditorTarget,
  entityNames,
} from "./components/DetailPanel";
import { ImportDialog, SourceViewer } from "./components/ImportDialog";
import { Modal } from "./components/Modal";
import { Preview } from "./components/Preview";
import { taskEvents, taskArrangements, taskNoticeTiming, noticeTimePassed, nextTaskArrangement } from './task-schedule';
import { effectiveActivityEnd } from '../domain/activity-duration';
import './task-attention.css';
const titles: Record<Page, string> = {
  today: "今天",
  calendar: "我的日历",
  inbox: "待判断",
  tasks: "任务",
  goals: "目标",
  settings: "设置",
  capture: "QQ 采集",
  ledger: "我的账单",
};
export function App({ api = window.planner }: { api?: DesktopAPI }) {
  const now = useCurrentTime();
  const ui = usePlanner(api),
    snapshot = ui.snapshot;
  const updates = useAppUpdates(api);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [captureReference, setCaptureReference] = useState<NonNullable<Source['captureRef']>>();
  const [ledgerCreateRequest, setLedgerCreateRequest] = useState(0);
  const [page, setPage] = useState<Page>("calendar"),
    [date, setDate] = useState(todayDate()),
    [selected, setSelected] = useState<Selection | null>(null),
    [editor, setEditor] = useState<EditorTarget | null>(null),
    [importing, setImporting] = useState(false),
    [courseOpen, setCourseOpen] = useState(false),
    [coursePreview, setCoursePreview] = useState<
      CourseImportResult | undefined
    >(),
    [sourceId, setSourceId] = useState<string | null>(null);
  useEffect(
    () =>
      api?.onNavigate((event) => {
        if (event.entity === "source") {
          setSourceId(event.id);
          return;
        }
        setSelected(event);
        setPage(
          event.entity === "candidate"
            ? "inbox"
            : event.entity === "task"
              ? "tasks"
              : event.entity === "goal"
                ? "goals"
                : event.entity === "preference" || event.entity === "feedback"
                  ? "settings"
                  : "calendar",
        );
      }),
    [api],
  );
  const pending =
    snapshot?.candidates.filter((c) => isPendingCandidate(c, now)).length ?? 0;
  const select = (s: Selection) => {
    if (s.entity === "source") {
      setSourceId(s.id);
      return;
    }
    setSelected(s);
  };
  const schedule = (draft: ScheduleDraft) =>
    setEditor({ entity: "block", id: draft.blockId, draft });
  const scheduleTask = (taskId: string, blockId?: string) => {
    if (!snapshot) return;
    const arrangements = taskArrangements(snapshot, taskId);
    const event = blockId ? arrangements.find(block => block.id === blockId && !block.cancelled) : nextTaskArrangement(arrangements, Date.now());
    if (event) {
      setEditor({ entity: 'block', id: event.id });
    } else if (arrangements.length || blockId) {
      setSelected({ entity: 'task', id: taskId });
    } else {
      const timing = taskNoticeTiming(snapshot, taskId);
      schedule(timing ? {
        date: timing.start.slice(0, 10), time: timing.start.slice(11, 16), taskId,
        end: effectiveActivityEnd(timing.start, timing.end).slice(0, 16), kind: 'event', location: timing.location,
        noticeTaskVersion: snapshot.tasks.find(task => task.id === taskId)?.version,
        timingNote: `${timing.end ? '已按原消息带入活动时间。' : '已按原消息带入开始时间；未提供结束时间，默认30分钟，可调整。'}${noticeTimePassed(timing, Date.now()) ? '原通知时间已过，请核对后保存。' : ''}`,
      } : { date: page === 'tasks' ? todayDate() : date, time: '09:00', taskId });
    }
  };
  const scheduleRecurringTask = (taskId: string) => {
    if (!snapshot) return;
    const event = taskEvents(snapshot, taskId).find(value => !value.cancelled && Date.parse(effectiveActivityEnd(value.start, value.end)) > Date.now());
    const timing = event ?? taskNoticeTiming(snapshot, taskId);
    setEditor({ entity: 'block', recurring: true, draft: {
      taskId, date: timing?.start.slice(0, 10) ?? todayDate(), time: timing?.start.slice(11, 16) ?? '09:00',
      kind: 'event', location: timing?.location ?? '',
    } });
  };
  const removeTask = (taskId: string) => {
    const task = snapshot?.tasks.find(value => value.id === taskId);
    if (task) void ui.mutate([{ type: 'removeTask', id: task.id, expectedVersion: task.version, includeLinkedBlocks: true }]);
  };
  const editSelected = () => {
    if (
      selected &&
      ["task", "block", "goal", "course", "candidate"].includes(selected.entity)
    )
      setEditor({
        ...selected,
        entity: selected.entity as EditorTarget["entity"],
      });
  };
  const settings = () => {
    setImporting(false);
    setSourceId(null);
    setCourseOpen(false);
    setPage("settings");
  };
  const source = snapshot?.sources.find((s) => s.id === sourceId);
  return (
    <div className={`app-shell${api ? ' desktop-chrome' : ''}`}>
      {api && <div className="window-drag-region" aria-hidden="true" />}
      <Sidebar
        page={page}
        navigate={setPage}
        pending={pending}
        onImport={() => setImporting(true)}
      />
      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-heading">
            <p className="eyebrow">
              {new Intl.DateTimeFormat("zh-CN", {
                timeZone: "Asia/Shanghai",
                month: "long",
                day: "numeric",
                weekday: "long",
              }).format(new Date())}
            </p>
            <div className="workspace-title-row">
              <h1>{titles[page]}</h1>
              {snapshot && (ui.busy || (!ui.error && ui.notice)) && (
                <span
                  className="workspace-notice"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  title={ui.busy ? "正在处理…" : ui.notice}
                >
                  {ui.busy ? "正在处理…" : ui.notice}
                </span>
              )}
            </div>
          </div>
          <div className="toolbar">
            <UpdateShortcut updates={updates} open={() => setUpdateOpen(true)} />
            <span className="local-status">
              <span className="live-dot" />
              {api ? "本地工作空间" : "桌面服务未连接"}
            </span>
            {snapshot && page !== "ledger" && (
              <button
                className="workspace-undo"
                aria-label="撤销上次操作"
                title="撤销上次操作"
                disabled={ui.busy || !snapshot.journal.some((entry) => entry.undoable && !entry.undoneAt)}
                onClick={() => void ui.undo()}
              >
                <Undo2 size={16} aria-hidden="true" />
                撤销
              </button>
            )}
            {snapshot && (
              <button
                className="primary"
                onClick={() => page === "ledger" ? setLedgerCreateRequest(value => value + 1) : setEditor({ entity: "task" })}
              >
                {page === "ledger" ? "＋ 记一笔" : "＋ 新建任务"}
              </button>
            )}
          </div>
        </header>
        {!api ? (
          <div className="service-state">
            <h2>请从桌面应用打开终极日历</h2>
            <p>此页面未连接本地数据服务。桌面应用会安全载入你的本机日历。</p>
          </div>
        ) : !snapshot ? (
          <div className="service-state">
            <h2>正在载入本机数据…</h2>
            {ui.error && <p className="error">{ui.error}</p>}
            <button onClick={() => void ui.refresh()}>重新载入</button>
          </div>
        ) : (
          <>
            {ui.error && (
              <div className="workspace-status">
                <span role="alert" className="error">
                  {ui.error}
                  <button onClick={() => ui.setError("")}>关闭提示</button>
                  {(ui.errorCode === "NO_API_KEY" || ui.errorCode === "AUTH") && (
                    <button onClick={settings}>配置密钥</button>
                  )}
                </span>
              </div>
            )}
            <div
              className={`workspace-body ${page === "settings" || page === "capture" || page === "ledger" ? "no-detail" : ""}`}
            >
              <div className="main-content">
                {page === "ledger" && <LedgerPage api={api} createRequest={ledgerCreateRequest} />}
                {page === "capture" && <CapturePage ui={ui} initialReference={captureReference} />}
                {page === "calendar" && (
                  <Calendar
                    snapshot={snapshot}
                    date={date}
                    setDate={setDate}
                    select={select}
                    schedule={schedule}
                    courses={() => {
                      setCoursePreview(undefined);
                      setCourseOpen(true);
                    }}
                  />
                )}
                {page === "inbox" && (
                  <Inbox
                    snapshot={snapshot}
                    ui={ui}
                    select={select}
                    edit={(id) => setEditor({ entity: "candidate", id })}
                    importMessage={() => setImporting(true)}
                    openSource={setSourceId}
                  />
                )}
                {page === "tasks" && (
                  <Tasks
                    snapshot={snapshot}
                    ui={ui}
                    select={select}
                    create={() => setEditor({ entity: "task" })}
                    editTask={(id) => setEditor({ entity: 'task', id })}
                    schedule={scheduleTask}
                    scheduleRecurring={scheduleRecurringTask}
                    removeTask={removeTask}
                  />
                )}
                {page === "goals" && (
                  <Goals
                    snapshot={snapshot}
                    select={select}
                    create={() => setEditor({ entity: "goal" })}
                  />
                )}
                {page === "settings" && (
                  <Settings
                    snapshot={snapshot}
                    ui={ui}
                    courses={() => setCourseOpen(true)}
                    updates={updates}
                  />
                )}
                {page === "today" && (
                  <div className="page-scroll today-page">
                    <div className="today-intro">
                      <span className="eyebrow">把注意力交给重要的事</span>
                      <h2>今天，从一件事开始。</h2>
                      <p>
                        {
                          snapshot.tasks.filter(
                            (t) =>
                              t.status === "open" &&
                              t.deadline &&
                              t.deadline.date <= todayDate(),
                          ).length
                        }{" "}
                        项临近或已到截止 · {pending} 项等待判断
                      </p>
                    </div>
                    <div className="today-stats">
                      <button onClick={() => setPage("tasks")}>
                        <strong>
                          {
                            snapshot.tasks.filter((t) => t.status === "open")
                              .length
                          }
                        </strong>
                        待完成任务
                      </button>
                      <button onClick={() => setPage("inbox")}>
                        <strong>{pending}</strong>等待判断
                      </button>
                      <button onClick={() => setPage("goals")}>
                        <strong>
                          {
                            snapshot.goals.filter((g) => g.status === "active")
                              .length
                          }
                        </strong>
                        进行中目标
                      </button>
                    </div>
                    <section>
                      <h3>今天的时间线</h3>
                      {buildCalendar(snapshot, todayDate(), todayDate(), false)
                        .length ? (
                        buildCalendar(
                          snapshot,
                          todayDate(),
                          todayDate(),
                          false,
                        ).map((item) => (
                          <button
                            className={`timeline-row ${item.category}`}
                            onClick={() =>
                              select({
                                entity: item.refKind,
                                id: item.refId,
                                occurrenceDate: todayDate(),
                              })
                            }
                            key={item.id}
                          >
                            <time>{item.start?.slice(11, 16) ?? "仅日期"}</time>
                            <strong>{item.title}</strong>
                            <small>
                              {item.category === "deadline"
                                ? "截止标记"
                                : item.location}
                            </small>
                          </button>
                        ))
                      ) : (
                        <div className="empty-state">
                          <h3>今天尚未安排时段</h3>
                          <button
                            onClick={() =>
                              schedule({ date: todayDate(), time: "09:00" })
                            }
                          >
                            安排一段专注时间
                          </button>
                        </div>
                      )}
                    </section>
                    <section>
                      <h3>需要行动的截止</h3>
                      {snapshot.tasks
                        .filter((t) => t.status === "open" && t.deadline)
                        .sort((a, b) =>
                          a.deadline!.date.localeCompare(b.deadline!.date),
                        )
                        .slice(0, 12)
                        .map((t) => (
                          <button
                            className="timeline-row"
                            key={t.id}
                            onClick={() => select({ entity: "task", id: t.id })}
                          >
                            <time>{t.deadline!.date}</time>
                            <strong>{t.title}</strong>
                            <small>
                              {t.deadline!.time ?? "具体时刻未提供"}
                            </small>
                          </button>
                        ))}
                    </section>
                    {!snapshot.sources.length &&
                      !snapshot.tasks.length &&
                      !snapshot.courses.length && (
                        <section className="onboarding">
                          <h3>让你的第一周清晰起来</h3>
                          <div className="toolbar wrap">
                            <button onClick={() => setImporting(true)}>
                              1 导入消息原文
                            </button>
                            <button onClick={() => setCourseOpen(true)}>
                              2 添加课表
                            </button>
                            <button onClick={settings}>3 配置 DeepSeek</button>
                          </div>
                        </section>
                      )}
                  </div>
                )}
              </div>
              {page !== "settings" && page !== "capture" && page !== "ledger" && (
                <DetailPanel
                  snapshot={snapshot}
                  selection={selected}
                  edit={editSelected}
                  editTask={(id) => setEditor({ entity: 'task', id })}
                  close={() => setSelected(null)}
                  schedule={scheduleTask}
                  scheduleRecurring={scheduleRecurringTask}
                  removeTask={removeTask}
                  ui={ui}
                />
              )}
            </div>
            <CommandBar
              ui={ui}
              selected={selected}
              date={date}
              domain={page === "ledger" ? "ledger" : undefined}
            />
          </>
        )}
      </main>
      {updateOpen && <Modal title="软件更新" onClose={() => setUpdateOpen(false)}><SoftwareUpdate updates={updates} plannerBusy={ui.busy} /></Modal>}
      {snapshot && (
        <>
          {importing && (
            <Modal title="导入消息" onClose={() => setImporting(false)}>
              <ImportDialog
                ui={ui}
                onClose={() => setImporting(false)}
                settings={settings}
              />
            </Modal>
          )}
          {courseOpen && (
            <Modal
              wide
              title="课程与导入校对"
              onClose={() => setCourseOpen(false)}
            >
              <CourseEditor
                key={coursePreview?.sourceId ?? "courses"}
                snapshot={snapshot}
                ui={ui}
                edit={setEditor}
                initial={coursePreview}
                openSource={setSourceId}
              />
            </Modal>
          )}
          {editor && (
            <Modal
              title={editor.recurring ? '重复安排' : `${editor.id ? "编辑" : "新建"}${entityNames[editor.entity]}`}
              onClose={() => setEditor(null)}
            >
              <EntityEditor
                key={`${editor.entity}:${editor.id ?? "new"}`}
                target={editor}
                snapshot={snapshot}
                ui={ui}
                onClose={() => setEditor(null)}
              />
            </Modal>
          )}
          {source && (
            <Modal wide title="原始来源" onClose={() => setSourceId(null)}>
              <SourceViewer
                source={source}
                onCapture={reference => { setCaptureReference(reference); setSourceId(null); setPage('capture'); }}
                ui={ui}
                onClose={() => setSourceId(null)}
                settings={settings}
                courses={(result) => {
                  setSourceId(null);
                  setCoursePreview(result);
                  setCourseOpen(true);
                }}
              />
            </Modal>
          )}
          {ui.preview && (
            <Modal wide title="更改预览" onClose={ui.cancelPreview}>
              <Preview
                value={ui.preview}
                confirm={() => void ui.confirm()}
                cancel={ui.cancelPreview}
                busy={ui.busy}
              />
            </Modal>
          )}
        </>
      )}
    </div>
  );
}
