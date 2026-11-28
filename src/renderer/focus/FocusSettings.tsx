import { FocusSettingsSchema, FOCUS_SETTING_KEYS, type Snapshot } from '../../shared/contracts';
import { useMobile } from '../mobile/layout';
import type { PlannerUI } from '../hooks/usePlanner';

const fields = [
  ['focusMinutes', '专注时长（分钟）', 480], ['shortBreakMinutes', '短休时长（分钟）', 120],
  ['longBreakMinutes', '长休时长（分钟）', 240], ['pomodorosBeforeLongBreak', '长休间隔（轮）', 24],
] as const;

export function FocusSettings({ snapshot, ui }: { snapshot: Snapshot; ui: PlannerUI }) {
  const base = snapshot.settings;
  const mobile = useMobile();
  const service = ui.host?.saveSettings ? ui.host : ui.client;
  return <form key={FOCUS_SETTING_KEYS.map(key => base[key]).join(',')} className="focus-form" aria-label="番茄钟与专注" onSubmit={async e => {
    e.preventDefault(); if (!service?.saveSettings) return;
    const data = new FormData(e.currentTarget);
    const options = FocusSettingsSchema.parse({ ...Object.fromEntries(fields.map(([key]) => [key, Number(data.get(key))])), focusSoundEnabled: data.has('sound') });
    await ui.run(() => service.saveSettings!({ settings: { ...base, ...options }, expectedSettings: base }), () => ui.setNotice('专注设置已保存'));
  }}>{!mobile && <h3>番茄钟与专注</h3>}
    <div className="focus-fields">{fields.map(([key, label, max]) => <label key={key}>{label}<input name={key} type="number" required min={1} max={max} defaultValue={base[key]}/></label>)}</div>
    <label className="focus-check"><input type="checkbox" name="sound" defaultChecked={base.focusSoundEnabled}/>到点提示音</label>
    <button className="ui-btn dark" disabled={ui.busy || !service?.saveSettings}>保存专注设置</button>
  </form>;
}
