import { useEffect, useRef, useState } from "react";
import type { CourseImportResult, DesktopAPI, LedgerViewContext, Source } from "../shared/contracts";
import type { HostCapabilities, PlannerClient } from "../shared/client";
import { resolveConnection } from "./client-context";
import { todayDate } from "./calendar-layout";
import { usePlanner } from "./hooks/usePlanner";
import { isPendingCandidate } from '../domain/candidate-eligibility';
import { useCurrentTime } from './hooks/useCurrentTime';
import { useAppUpdates } from './hooks/useAppUpdates';
import { SoftwareUpdate, UpdateShortcut } from './components/SoftwareUpdate';
import { Nav, type Page } from "./components/shell/Nav";
import { Assistant } from "./components/shell/Assistant";
import { Calendar, type Selection } from "./components/Calendar";
import { Inbox } from "./components/Inbox";
import { LedgerPage } from "./components/LedgerPage";
import { EntityEditor, type EditorTarget } from "./components/editor/EntityEditor";
import { EditPanel } from "./components/editor/EditPanel";
import { DetailPopover } from "./components/detail/DetailPopover";
import { entityNames } from "./components/detail/records";
import { ImportDialog, SourceViewer } from "./components/ImportDialog";
import { Modal } from "./components/Modal";
import { Preview } from "./components/Preview";
import { Today } from "./pages/today/Today";
import { UnscheduledDrawer } from "./components/calendar/UnscheduledDrawer";
import { unscheduledTasks } from "../domain/unscheduled";
import { MePage, type MeSection } from "./pages/me/MePage";
import { taskActionHandlers } from './task-actions';
import './theme/tokens.css';
import './theme/base.css';
import './theme/forms.css';
import './task-attention.css';
import './components/shell/shell.css';

export function App(props: { api?: DesktopAPI; client?: PlannerClient; host?: HostCapabilities }) {
  const { client: api, host } = resolveConnection(props);
  const now = useCurrentTime();
  const ui = usePlanner(api, host),
    snapshot = ui.snapshot;
  const updates = useAppUpdates(host);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [captureReference, setCaptureReference] = useState<NonNullable<Source['captureRef']>>();
  const [ledgerView, setLedgerView] = useState<LedgerViewContext>();
  const [page, setPage] = useState<Page>("calendar"),
    [meSection, setMeSection] = useState<MeSection>("goals"),
    [date, setDate] = useState(todayDate()),
    [selected, setSelected] = useState<Selection | null>(null),
    [editor, setEditor] = useState<EditorTarget | null>(null),
    [importing, setImporting] = useState(false),
    [coursePreview, setCoursePreview] = useState<CourseImportResult | undefined>(),
    [sourceId, setSourceId] = useState<string | null>(null),
    [drawerOpen, setDrawerOpen] = useState(true),
    [anchor, setAnchor] = useState<DOMRect | null>(null);
  const pointer = useRef<{ target: Element; at: number } | null>(null);
  useEffect(() => {
    const down = (event: PointerEvent) => { pointer.current = { target: event.target as Element, at: Date.now() }; };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);
  /** The item a selection came from, so the detail card opens beside it; keyboard selections use the focused control. */
  const anchorRect = () => {
    const recent = pointer.current && Date.now() - pointer.current.at < 1000 ? pointer.current.target : null;
    const active = document.activeElement !== document.body ? document.activeElement : null;
    const node = (recent ?? active)?.closest(".timeline-event, .timeline-point, .marker, .month-item, .a2-task-row, .a2-card, button, [role=button]");
    return node && !node.closest(".a2-pop") ? node.getBoundingClientRect() : null;
  };
  const openMe = (section: MeSection) => { setMeSection(section); setPage("me"); };
  useEffect(
    () =>
      host?.onNavigate((event) => {
        if (event.entity === "source") {
          setSourceId(event.id);
          return;
        }
        setSelected(event);
        setAnchor(null);
        if (event.entity === "goal") openMe("goals");
        else if (event.entity === "preference" || event.entity === "feedback") openMe("ai");
        else setPage(event.entity === "candidate" ? "inbox" : event.entity === "task" ? "today" : "calendar");
      }),
    [host],
  );
  const pending = snapshot?.candidates.filter((c) => isPendingCandidate(c, now)).length ?? 0;
  const select = (s: Selection) => {
    if (s.entity === "source") {
      setSourceId(s.id);
      return;
    }
    setAnchor(anchorRect());
    setSelected(s);
  };
  const editRecord = (target: EditorTarget) => {
    setSelected(null);
    setEditor(target);
  };
  const { schedule, scheduleTask, scheduleRecurringTask, removeTask } = taskActionHandlers({ snapshot, ui, select: setSelected, editRecord });
  const editSelected = () => {
    if (selected && ["task", "block", "goal", "course", "candidate"].includes(selected.entity))
      editRecord({ ...selected, entity: selected.entity as EditorTarget["entity"] });
  };
  const keySettings = () => {
    setImporting(false);
    setSourceId(null);
    openMe("ai");
  };
  const taskActions = { select, editTask: (id: string) => editRecord({ entity: 'task', id }), schedule: scheduleTask, scheduleRecurring: scheduleRecurringTask, removeTask };
  const detail = () => snapshot && selected && (
    <DetailPopover key={`${selected.entity}:${selected.id}:${selected.occurrenceDate ?? ''}`} snapshot={snapshot} selection={selected} anchor={anchor} ui={ui}
      close={() => setSelected(null)} actions={{ ...taskActions, edit: editSelected }} />
  );
  const editPanel = (overlay: boolean) => snapshot && editor && (
    <EditPanel overlay={overlay} title={editor.recurring ? '重复安排' : `${editor.id ? "编辑" : "新建"}${entityNames[editor.entity]}`} onClose={() => setEditor(null)}>
      <EntityEditor key={`${editor.entity}:${editor.id ?? "new"}:${editor.recurring ? 'recurring' : ''}:${editor.draft ? JSON.stringify(editor.draft) : ''}`} target={editor} snapshot={snapshot} ui={ui} onClose={() => setEditor(null)} />
    </EditPanel>
  );
  const source = snapshot?.sources.find((s) => s.id === sourceId);
  return (
    <div className={`app-shell a2${host ? ' desktop-chrome' : ''}`}>
      {host && <div className="window-drag-region" aria-hidden="true" />}
      <Nav page={page} navigate={(next) => { setEditor(null); setPage(next); }} pending={pending} />
      {host && <div className="a2-nav-update"><UpdateShortcut updates={updates} open={() => setUpdateOpen(true)} /></div>}
      <main className="a2-main">
        {!api ? (
          <div className="a2-service"><h2>请从桌面应用打开终极日历</h2><p>此页面未连接本地数据服务。</p></div>
        ) : !snapshot ? (
          <div className="a2-service">
            <h2>正在载入本机数据…</h2>
            {ui.error && <p className="error">{ui.error}</p>}
            <button className="ui-btn" onClick={() => void ui.refresh()}>重新载入</button>
          </div>
        ) : (
          <>
            {ui.error && (
              <div className="a2-error" role="alert">
                <span className="error">{ui.error}</span>
                {(ui.errorCode === "NO_API_KEY" || ui.errorCode === "AUTH") && ui.host && <button className="ui-btn sm" onClick={keySettings}>配置密钥</button>}
                <button className="ui-btn sm ghost" onClick={() => ui.setError("")}>关闭提示</button>
              </div>
            )}
            <div className="a2-page-slot">
              {page === "today" && (
                <Today snapshot={snapshot} ui={ui} pendingCount={pending} create={() => editRecord({ entity: "task" })} openInbox={() => setPage("inbox")}
                  openCandidate={(id) => { setSelected({ entity: "candidate", id }); setPage("inbox"); }}
                  openRecord={editRecord} goCalendar={() => setPage("calendar")} {...taskActions} />
              )}
              {page === "calendar" && (
                <Calendar snapshot={snapshot} date={date} setDate={setDate} select={select} schedule={schedule} ui={ui}
                  edit={(s) => { if (["task", "block", "course", "candidate"].includes(s.entity)) editRecord({ ...s, entity: s.entity as EditorTarget["entity"] }); }}
                  courses={() => { setCoursePreview(undefined); openMe("courses"); }}
                  drawerOpen={drawerOpen} toggleDrawer={() => setDrawerOpen(open => !open)} unscheduledCount={unscheduledTasks(snapshot, now).length}
                  panel={editPanel(false) || undefined} openCandidate={(id) => { setSelected({ entity: "candidate", id }); setPage("inbox"); }}
                  drawer={drawerOpen ? <UnscheduledDrawer snapshot={snapshot} ui={ui} now={now} collapse={() => setDrawerOpen(false)} actions={taskActions} /> : null} />
              )}
              {page === "inbox" && (
                <Inbox snapshot={snapshot} ui={ui} select={select} edit={(id) => editRecord({ entity: "candidate", id })} host={host}
                  importMessage={() => setImporting(true)} openSource={setSourceId} focus={selected?.entity === "candidate" ? selected.id : null} />
              )}
              {page === "ledger" && (
                <LedgerPage api={api} host={host} onViewChange={setLedgerView} />
              )}
              {page === "me" && (
                <MePage snapshot={snapshot} ui={ui} section={meSection} setSection={setMeSection} updates={updates} select={select}
                  edit={editRecord} openSource={setSourceId} coursePreview={coursePreview} captureReference={captureReference} />
              )}
              {page !== "calendar" && editPanel(true)}
            </div>
            {(page !== "inbox" || selected?.entity !== "candidate") && !editor && detail()}
            <Assistant ui={ui} selected={selected} date={date} domain={page === "ledger" ? "ledger" : undefined} ledgerView={page === "ledger" ? ledgerView : undefined} />
          </>
        )}
      </main>
      {updateOpen && <Modal title="软件更新" onClose={() => setUpdateOpen(false)}><SoftwareUpdate updates={updates} plannerBusy={ui.busy} /></Modal>}
      {snapshot && (
        <>
          {importing && (
            <Modal title="导入消息" onClose={() => setImporting(false)}>
              <ImportDialog ui={ui} onClose={() => setImporting(false)} settings={keySettings} />
            </Modal>
          )}
          {source && (
            <Modal wide title="原始来源" onClose={() => setSourceId(null)}>
              <SourceViewer
                source={source}
                onCapture={host ? reference => { setCaptureReference(reference); setSourceId(null); openMe('capture'); } : undefined}
                ui={ui}
                onClose={() => setSourceId(null)}
                settings={keySettings}
                courses={(result) => { setSourceId(null); setCoursePreview(result); openMe("courses"); }}
              />
            </Modal>
          )}
          {ui.preview && (
            <Modal wide title="更改预览" onClose={ui.cancelPreview}>
              <Preview value={ui.preview} confirm={() => void ui.confirm()} cancel={ui.cancelPreview} busy={ui.busy}
                names={id => snapshot && ([...snapshot.tasks, ...snapshot.goals, ...snapshot.courses, ...snapshot.candidates, ...snapshot.blocks].find(record => record.id === id)?.title
                  ?? snapshot.sources.find(source => source.id === id)?.label ?? undefined)} />
            </Modal>
          )}
        </>
      )}
    </div>
  );
}
