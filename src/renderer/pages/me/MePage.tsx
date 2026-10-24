import type { CourseImportResult, Snapshot, Source } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { AppUpdates } from "../../hooks/useAppUpdates";
import type { Selection } from "../../components/Calendar";
import type { EditorTarget } from "../../components/editor/EntityEditor";
import { PageToolbar } from "../../components/shell/PageToolbar";
import { Goals } from "./Goals";
import { CourseEditor } from "../../components/CourseEditor";
import { CapturePage } from "../../components/CapturePage";
import { Settings, type SettingsSection } from "../../components/Settings";
import { LedgerRulesSettings } from "../../components/ledger/Rules";
import "./MePage.css";

export type MeSection = "goals" | "courses" | "capture" | "ai" | "term" | "reminders" | "ledger" | "data" | "update";
const groups: { title: string; host?: boolean; items: [MeSection, string][] }[] = [
  { title: "规划", items: [["goals", "目标"], ["courses", "课程表"]] },
  { title: "采集", host: true, items: [["capture", "QQ 采集"]] },
  { title: "设置", host: true, items: [["ai", "AI 与费用"], ["term", "学期与节次"], ["reminders", "提醒与启动"], ["ledger", "记账"], ["data", "数据与备份"], ["update", "软件更新"]] },
];

const settingsSections: MeSection[] = ["ai", "term", "reminders", "data", "update"];

export function MePage({ snapshot, ui, section, setSection, updates, select, edit, openSource, coursePreview, captureReference }: {
  snapshot: Snapshot;
  ui: PlannerUI;
  section: MeSection;
  setSection: (section: MeSection) => void;
  updates: AppUpdates;
  select: (selection: Selection) => void;
  edit: (target: EditorTarget) => void;
  openSource: (id: string) => void;
  coursePreview?: CourseImportResult;
  captureReference?: NonNullable<Source["captureRef"]>;
}) {
  const visible = groups.filter(group => !group.host || ui.host);
  const current = visible.some(group => group.items.some(([id]) => id === section)) ? section : "goals";
  const label = groups.flatMap(group => group.items).find(([id]) => id === current)![1];
  return (
    <div className="a2-page">
      <PageToolbar title="我的" ui={ui} />
      <div className="a2-me">
        <nav className="a2-me-menu" aria-label="我的">
          {visible.map(group => (
            <div key={group.title}>
              <h2>{group.title}</h2>
              {group.items.map(([id, label]) => (
                <button key={id} className={current === id ? "on" : ""} aria-current={current === id ? "page" : undefined} onClick={() => setSection(id)}>{label}</button>
              ))}
            </div>
          ))}
        </nav>
        <section className="a2-me-content" aria-label={label}>
          {current === "goals" && <Goals snapshot={snapshot} ui={ui} select={select} create={() => edit({ entity: "goal" })} />}
          {current === "courses" && <CourseEditor key={coursePreview?.sourceId ?? "courses"} snapshot={snapshot} ui={ui} edit={edit} initial={coursePreview} openSource={openSource} />}
          {current === "capture" && <CapturePage ui={ui} initialReference={captureReference} />}
          {current === "ledger" && ui.client && <LedgerRulesSettings api={ui.client} />}
          {settingsSections.includes(current) && (
            <Settings snapshot={snapshot} ui={ui} courses={() => setSection("courses")} updates={updates} section={current as SettingsSection} onSection={setSection} />
          )}
        </section>
      </div>
    </div>
  );
}
