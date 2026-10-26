import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { CourseImportResult, Snapshot } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import type { Selection } from '../../components/Calendar';
import type { EditorTarget } from '../../components/editor/EntityEditor';
import { Goals } from '../../pages/me/Goals';
import { CourseEditor } from '../../components/CourseEditor';
import { LedgerRulesSettings } from '../../components/ledger/Rules';
import { CourseList } from './CourseList';
import { teachingWeek } from '../../pages/today/Today';
import { todayDate } from '../../calendar-layout';

/** A settings page supplied by the connection layer (key, reminders, device), shown under 设置. */
export interface SettingsPage { id: string; label: string; summary?: string; content: ReactNode; /** An action beside the page title, e.g. add. */ action?: ReactNode; subtitle?: string }

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
  const courseCount = new Set(snapshot.courses.map(course => course.title)).size;
  const week = teachingWeek(snapshot.settings.termStart, todayDate());
  const pages: SettingsPage[] = [
    { id: 'goals', label: '目标', summary: activeGoals ? `${activeGoals} 个进行中` : '未设定', content: <Goals snapshot={snapshot} ui={ui} select={select} create={() => edit({ entity: 'goal' })} /> },
    { id: 'courses', label: '课程表', summary: courseCount ? `${courseCount} 门课` : '未添加',
      subtitle: [week && week <= snapshot.settings.termWeeks ? `第 ${week} 周 · 共 ${snapshot.settings.termWeeks} 周` : '', courseCount ? `${courseCount} 门课` : ''].filter(Boolean).join(' · '),
      // A course import preview (from a retried timetable source) still needs the full proofreading table.
      content: coursePreview ? <CourseEditor key={coursePreview.sourceId ?? 'courses'} snapshot={snapshot} ui={ui} edit={edit} initial={coursePreview} openSource={openSource} />
        : <CourseList snapshot={snapshot} ui={ui} edit={edit} />,
      action: <button className="m-icon" aria-label="添加课程" onClick={() => edit({ entity: 'course' })}><Plus aria-hidden="true" /></button> },
    ...settingsPages.map(page => page.id === 'ai' && !page.summary ? { ...page, summary: snapshot.keyStatus.configured ? '已配置' : '未填 Key' } : page),
    ...(ui.client ? [{ id: 'ledger-rules', label: '记账规则', content: <LedgerRulesSettings api={ui.client} /> }] : []),
  ];
  const open = pages.find(page => page.id === section);
  if (open) return (
    <div className="m-page m-subpage">
      <header className="m-subpage-head">
        <button className="m-link m-back" aria-label="返回我的" onClick={() => setSection(null)}><ChevronLeft aria-hidden="true" />我的</button>
        <div className="m-hero"><div><h1>{open.label}</h1>{open.subtitle && <p>{open.subtitle}</p>}</div>{open.action}</div>
      </header>
      <div className={['goals', 'ledger-rules'].includes(open.id) || open.id === 'courses' && coursePreview ? 'm-legacy' : undefined}>{open.content}</div>
    </div>
  );
  const row = (page: SettingsPage) => <li key={page.id}><button className="m-card-row" onClick={() => setSection(page.id)}>
    <span className="m-card-main"><b>{page.label}</b></span>
    {page.summary && <span className={`m-card-value${page.id === 'ai' && !snapshot.keyStatus.configured ? ' attn' : ''}`}>{page.summary}</span>}<ChevronRight aria-hidden="true" />
  </button></li>;
  const planning = ['goals', 'courses'], order = ['ai', 'reminders', 'ledger-rules', 'device'];
  return (
    <div className="m-page m-me">
      <header className="m-hero"><div><h1>我的</h1></div></header>
      {pendingCount > 0 && <button className="m-notice-row" onClick={openPending}><span><b>{pendingCount}</b> 项修改待提交</span><ChevronRight aria-hidden="true" /></button>}
      <h2 className="m-card-label">规划</h2>
      <ul className="m-card">{pages.filter(page => planning.includes(page.id)).map(row)}</ul>
      <h2 className="m-card-label">设置</h2>
      <ul className="m-card">{pages.filter(page => !planning.includes(page.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map(row)}</ul>
    </div>
  );
}
