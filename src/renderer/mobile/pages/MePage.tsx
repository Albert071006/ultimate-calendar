import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CourseImportResult, Snapshot } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import type { Selection } from '../../components/Calendar';
import type { EditorTarget } from '../../components/editor/EntityEditor';
import { Goals } from '../../pages/me/Goals';
import { CourseEditor } from '../../components/CourseEditor';
import { LedgerRulesSettings } from '../../components/ledger/Rules';

/** A settings page supplied by the connection layer (key, reminders, device), shown under 设置. */
export interface SettingsPage { id: string; label: string; summary?: string; content: ReactNode }

/**
 * 我的 on the phone: 规划 and 设置 as one list; each entry opens its own page with a back button.
 * Unsent changes appear at the top only while there are any.
 */
export function MePage({ snapshot, ui, section, setSection, pendingCount, openPending, settingsPages, select, edit, openSource, coursePreview }: {
  snapshot: Snapshot; ui: PlannerUI; section: string | null; setSection: (section: string | null) => void;
  pendingCount: number; openPending: () => void; settingsPages: SettingsPage[];
  select: (selection: Selection) => void; edit: (target: EditorTarget) => void; openSource: (id: string) => void; coursePreview?: CourseImportResult;
}) {
  const activeGoals = snapshot.goals.filter(goal => goal.status === 'active').length;
  const pages: SettingsPage[] = [
    { id: 'goals', label: '目标', summary: activeGoals ? `${activeGoals} 个进行中` : '未设定', content: <Goals snapshot={snapshot} ui={ui} select={select} create={() => edit({ entity: 'goal' })} /> },
    { id: 'courses', label: '课程表', summary: snapshot.courses.length ? `${snapshot.courses.length} 门课` : '未导入', content: <CourseEditor key={coursePreview?.sourceId ?? 'courses'} snapshot={snapshot} ui={ui} edit={edit} initial={coursePreview} openSource={openSource} /> },
    ...settingsPages.map(page => page.id === 'ai' && !page.summary ? { ...page, summary: snapshot.keyStatus.configured ? '已配置' : '未配置 Key' } : page),
    ...(ui.client ? [{ id: 'ledger-rules', label: '记账规则', content: <LedgerRulesSettings api={ui.client} /> }] : []),
  ];
  const open = pages.find(page => page.id === section);
  if (open) return (
    <div className="m-page m-subpage">
      <header className="m-subpage-head">
        <button className="m-link m-back" aria-label="返回我的" onClick={() => setSection(null)}><ChevronLeft aria-hidden="true" />我的</button>
        <h1>{open.label}</h1>
      </header>
      <div className={['goals', 'courses', 'ledger-rules'].includes(open.id) ? 'm-legacy' : undefined}>{open.content}</div>
    </div>
  );
  const row = (page: SettingsPage) => <li key={page.id}><button className="m-menu-row" onClick={() => setSection(page.id)}>
    <span>{page.label}</span>{page.summary && <small>{page.summary}</small>}<ChevronRight aria-hidden="true" />
  </button></li>;
  const planning = ['goals', 'courses'], order = ['ai', 'reminders', 'ledger-rules', 'device'];
  return (
    <div className="m-page m-me">
      <header className="m-hero"><div><h1>我的</h1></div></header>
      {pendingCount > 0 && <button className="m-notice-row" onClick={openPending}><span><b>{pendingCount}</b> 项修改待提交</span><ChevronRight aria-hidden="true" /></button>}
      <h2 className="m-group-title">规划</h2>
      <ul className="m-menu">{pages.filter(page => planning.includes(page.id)).map(row)}</ul>
      <h2 className="m-group-title">设置</h2>
      <ul className="m-menu">{pages.filter(page => !planning.includes(page.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map(row)}</ul>
    </div>
  );
}
