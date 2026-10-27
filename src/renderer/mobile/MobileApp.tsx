import { useEffect, useState, type ReactNode } from 'react';
import { CalendarDays, Inbox as InboxIcon, Sun, UserRound, Wallet } from 'lucide-react';
import type { CourseImportResult, LedgerViewContext } from '../../shared/contracts';
import type { PlannerClient } from '../../shared/client';
import { usePlanner } from '../hooks/usePlanner';
import { useCurrentTime } from '../hooks/useCurrentTime';
import { isPendingCandidate } from '../../domain/candidate-eligibility';
import { unscheduledTasks } from '../../domain/unscheduled';
import { todayDate } from '../calendar-layout';
import { taskActionHandlers } from '../task-actions';
import type { Selection } from '../components/Calendar';
import type { Page } from '../components/shell/Nav';
import { Inbox } from '../components/Inbox';
import { LedgerPage } from '../components/LedgerPage';
import { EntityEditor, type EditorTarget } from '../components/editor/EntityEditor';
import { EditPanel } from '../components/editor/EditPanel';
import { DetailPopover } from '../components/detail/DetailPopover';
import { entityNames } from '../components/detail/records';
import { ImportDialog, SourceViewer } from '../components/ImportDialog';
import { Preview } from '../components/Preview';
import { MePage, type SettingsPage } from './pages/MePage';
import type { RemoteClientState } from '../remote/types';
import { MobileProvider, useVisualViewport } from './layout';
import { MobileAssistant } from './MobileAssistant';
import { Sheet } from './Sheet';
import { StatusBanner } from './StatusBanner';
import { UnscheduledSheet } from './UnscheduledSheet';
import { TodayPage } from './pages/TodayPage';
import { CalendarPage, nextSlot, type PhoneView } from './pages/CalendarPage';
import '../theme/tokens.css';
import '../theme/base.css';
import '../theme/forms.css';
import '../task-attention.css';
import '../components/shell/shell.css';
import './mobile.css';
import './shell.css';

const tabs: [Page, string, typeof Sun][] = [['today', '今天', Sun], ['calendar', '日历', CalendarDays], ['inbox', '待判断', InboxIcon], ['ledger', '账单', Wallet], ['me', '我的', UserRound]];

/**
 * The phone shell (ADR 0002): its own header-less pages, bottom tabs, sheets and full-screen editor, sharing
 * only the planner state, rules and record components with the desktop.
 */
export function MobileApp({ client, connection, settingsPages = [], pendingView, discardPreview, conversationKey }: {
  client: PlannerClient;
  /** Local storage key for the assistant conversation, scoped to this pairing and data instance. */
  conversationKey?: string;
  connection: Pick<RemoteClientState, 'status' | 'pending' | 'cachedAt' | 'storageError'>;
  /** Drops the phone's queued copy of a preview the user declined, so it does not linger as "needs handling". */
  discardPreview?: (confirmationToken: string) => void;
  /** Key, reminder and device pages supplied by the connection, listed under 我的 → 设置. */
  settingsPages?: SettingsPage[];
  /** Connection details and the phone's unsent changes, opened from the status banner. */
  pendingView?: ReactNode;
}) {
  useVisualViewport();
  // iOS Safari only applies :active styles once the page listens for touches.
  useEffect(() => { const touch = () => {}; document.addEventListener('touchstart', touch, { passive: true }); return () => document.removeEventListener('touchstart', touch); }, []);
  const now = useCurrentTime();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const ui = usePlanner(client), snapshot = ui.snapshot;
  const [page, setPage] = useState<Page>('today');
  const [meSection, setMeSection] = useState<string | null>(null);
  const [date, setDate] = useState(todayDate());
  const [calendarView, setCalendarView] = useState<PhoneView>('day');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [unscheduledOpen, setUnscheduledOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [coursePreview, setCoursePreview] = useState<CourseImportResult | undefined>();
  const [ledgerView, setLedgerView] = useState<LedgerViewContext>();

  const select = (selection: Selection) => selection.entity === 'source' ? setSourceId(selection.id) : setSelected(selection);
  const editRecord = (target: EditorTarget) => { setSelected(null); setUnscheduledOpen(false); setEditor(target); };
  const { schedule, scheduleTask, scheduleRecurringTask, scheduleAdditionalTask, removeTask } = taskActionHandlers({ snapshot, ui, select: setSelected, editRecord, defaultSlot: () => ({ date: todayDate(), time: nextSlot(Date.now(), true) }) });
  const taskActions = { select, editTask: (id: string) => editRecord({ entity: 'task', id }), schedule: scheduleTask, scheduleRecurring: scheduleRecurringTask, scheduleAdditional: scheduleAdditionalTask, removeTask };
  const openMe = (section: string) => { setMeSection(section); setPage('me'); };
  const navigate = (next: Page) => { setEditor(null); setSelected(null); setUnscheduledOpen(false); if (next === 'me') setMeSection(null); setPage(next); };
  const openCandidate = (id: string) => { setSelected({ entity: 'candidate', id }); setPage('inbox'); };
  const pending = snapshot?.candidates.filter(candidate => isPendingCandidate(candidate, now)).length ?? 0;
  const unscheduled = snapshot ? unscheduledTasks(snapshot, now).length : 0;
  const editSelected = () => {
    if (selected && ['task', 'block', 'goal', 'course', 'candidate'].includes(selected.entity)) editRecord({ ...selected, entity: selected.entity as EditorTarget['entity'] });
  };
  const declinePreview = () => {
    const token = ui.preview?.confirmationToken;
    ui.cancelPreview();
    if (token) discardPreview?.(token);
  };
  // The preview being reviewed right now is not yet something the banner should ask about.
  const banner = ui.preview ? { ...connection, pending: connection.pending.filter(item => item.preview?.confirmationToken !== ui.preview!.confirmationToken) } : connection;
  const source = snapshot?.sources.find(value => value.id === sourceId);
  const names = (id: string) => !snapshot ? undefined : ([...snapshot.tasks, ...snapshot.goals, ...snapshot.courses, ...snapshot.candidates, ...snapshot.blocks].find(record => record.id === id)?.title
    ?? snapshot.sources.find(value => value.id === id)?.label ?? undefined);

  return (
    <MobileProvider mobile>
      <div className="a2 is-mobile m-app">
        <StatusBanner connection={banner} onOpen={() => setStatusOpen(true)} />
        {ui.error && <div className="m-error" role="alert">
          <span>{ui.error}</span>
          {(ui.errorCode === 'NO_API_KEY' || ui.errorCode === 'AUTH') && <button className="m-link" onClick={() => { ui.setError(''); openMe('ai'); }}>去设置</button>}
          <button className="m-link" onClick={() => ui.setError('')}>关闭</button>
        </div>}
        <main className={`m-main page-${page}`}>
          {!snapshot ? (
            <div className="m-loading">
              <p>{ui.error ? '资料暂时无法读取。' : '正在载入…'}</p>
              {ui.error && <button className="m-btn" onClick={() => void ui.refresh()}>重新载入</button>}
            </div>
          ) : page === 'today' ? (
            <TodayPage snapshot={snapshot} ui={ui} now={now} pendingCount={pending} unscheduledCount={unscheduled} select={select}
              openCandidate={openCandidate} openInbox={() => navigate('inbox')} openUnscheduled={() => setUnscheduledOpen(true)}
              createTask={() => editRecord({ entity: 'task' })} actions={taskActions} />
          ) : page === 'calendar' ? (
            <CalendarPage snapshot={snapshot} now={now} date={date} setDate={setDate} view={calendarView} setView={setCalendarView}
              select={select} schedule={schedule} openCandidate={openCandidate} unscheduledCount={unscheduled}
              openUnscheduled={() => setUnscheduledOpen(true)} openCourses={() => { setCoursePreview(undefined); openMe('courses'); }} />
          ) : page === 'inbox' ? (
            <Inbox snapshot={snapshot} ui={ui} select={select} edit={id => editRecord({ entity: 'candidate', id })}
              importMessage={() => setImporting(true)} openSource={setSourceId} focus={selected?.entity === 'candidate' ? selected.id : null} />
          ) : page === 'ledger' ? (
            <LedgerPage api={client} onViewChange={setLedgerView} />
          ) : (
            <MePage snapshot={snapshot} ui={ui} section={meSection} setSection={setMeSection} pendingCount={connection.pending.length} openPending={() => setStatusOpen(true)}
              settingsPages={settingsPages} select={select} edit={editRecord} openSource={setSourceId} coursePreview={coursePreview} />
          )}
        </main>
        {snapshot && <Toast ui={ui} />}
        {snapshot && <MobileAssistant ui={ui} selected={selected} date={date} domain={page === 'ledger' ? 'ledger' : undefined} connectionStatus={connection.status}
          ledgerView={page === 'ledger' ? ledgerView : undefined} storageKey={conversationKey} open={assistantOpen} setOpen={setAssistantOpen} />}
        <nav className="m-tabs-bar" aria-label="主导航">
          {tabs.map(([id, label, Icon]) => (
            <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
              <Icon aria-hidden="true" strokeWidth={1.7} /><span>{label}</span>
              {id === 'inbox' && pending > 0 && <b aria-label={`${pending} 条待判断`}>{pending}</b>}
            </button>
          ))}
        </nav>

        {snapshot && selected && !editor && !(page === 'inbox' && selected.entity === 'candidate') && (
          <DetailPopover key={`${selected.entity}:${selected.id}:${selected.occurrenceDate ?? ''}`} snapshot={snapshot} selection={selected} anchor={null} ui={ui}
            close={() => setSelected(null)} actions={{ ...taskActions, edit: editSelected }} />
        )}
        {snapshot && unscheduledOpen && !editor && (
          <UnscheduledSheet snapshot={snapshot} now={now} close={() => setUnscheduledOpen(false)} select={select}
            schedule={id => { setUnscheduledOpen(false); scheduleTask(id); }} />
        )}
        {snapshot && editor && (
          <EditPanel overlay title={editor.recurring ? '重复安排' : `${editor.id ? '编辑' : '新建'}${entityNames[editor.entity]}`} onClose={() => setEditor(null)}>
            <EntityEditor key={`${editor.entity}:${editor.id ?? 'new'}:${editor.recurring ? 'recurring' : ''}:${editor.draft ? JSON.stringify(editor.draft) : ''}`}
              target={editor} snapshot={snapshot} ui={ui} onClose={() => setEditor(null)} />
          </EditPanel>
        )}
        {snapshot && importing && <Sheet title="导入消息" onClose={() => setImporting(false)}>
          <ImportDialog ui={ui} onClose={() => setImporting(false)} settings={() => { setImporting(false); openMe('ai'); }} />
        </Sheet>}
        {snapshot && source && <Sheet title="来源" onClose={() => setSourceId(null)}>
          <SourceViewer source={source} ui={ui} onClose={() => setSourceId(null)} settings={() => { setSourceId(null); openMe('ai'); }}
            courses={result => { setSourceId(null); setCoursePreview(result); openMe('courses'); }} />
        </Sheet>}
        {snapshot && ui.preview && <Sheet title="确认更改" onClose={declinePreview}>
          <Preview value={ui.preview} confirm={() => void ui.confirm()} cancel={declinePreview} busy={ui.busy} names={names} />
        </Sheet>}
        {statusOpen && <Sheet title="连接与待提交" onClose={() => setStatusOpen(false)}>{pendingView}</Sheet>}
      </div>
    </MobileProvider>
  );
}

/** The latest save result for a few seconds, with undo while the last change can still be undone. */
function Toast({ ui }: { ui: ReturnType<typeof usePlanner> }) {
  const [shown, setShown] = useState('');
  useEffect(() => {
    if (!ui.notice) return;
    setShown(ui.notice);
    const timer = setTimeout(() => setShown(''), 4000);
    return () => clearTimeout(timer);
  }, [ui.notice]);
  const text = ui.busy ? '正在处理…' : ui.error ? '' : shown;
  if (!text) return null;
  const undoable = !ui.busy && !/^(尚未执行|已取消)/.test(text) && !!ui.snapshot?.journal.some(entry => entry.undoable && !entry.undoneAt);
  return (
    <div className="m-toast" role="status" aria-live="polite">
      <span>{undoable ? text.replace(/[，,]?\s*可撤销$/, '') : text}</span>
      {undoable && <button className="m-link" onClick={() => { setShown(''); void ui.undo(); }}>撤销</button>}
    </div>
  );
}
