import { useState } from "react";
import { Plus } from "lucide-react";
import {
  CourseInputSchema,
  type CourseImportResult,
  type CourseInput,
  type Snapshot,
} from "../../shared/contracts";
import { operationId } from "../calendar-layout";
import type { PlannerUI } from "../hooks/usePlanner";
import type { EditorTarget } from "./editor/EntityEditor";
import { MoreMenu } from "./shell/MoreMenu";
import { ColorPicker } from "../pages/me/ColorPicker";
import { occupiedColors } from "../../domain/palette";
import { dayDistance } from "../../domain/time";
import { todayDate } from "../calendar-layout";
const headers = [
  "课程",
  "星期",
  "开始",
  "结束",
  "起始周",
  "结束周",
  "单双周",
  "地点",
];
export function CourseEditor({
  snapshot,
  ui,
  edit,
  initial,
  openSource,
}: {
  snapshot: Snapshot;
  ui: PlannerUI;
  edit: (target: EditorTarget) => void;
  initial?: CourseImportResult;
  openSource: (id: string) => void;
}) {
  const [preview, setPreview] = useState<CourseImportResult | null>(
      initial ?? null,
    ),
    [rows, setRows] = useState(initial?.drafts ?? []),
    [weeks, setWeeks] = useState<Record<number, string>>({}),
    [term, setTerm] = useState(snapshot.settings.termStart ?? ""),
    [error, setError] = useState(""),
    [text, setText] = useState(""),
    [pasting, setPasting] = useState(false);
  function receive(result: CourseImportResult) {
    setPreview(result);
    setRows(result.drafts);
    setWeeks({});
    setError("");
  }
  async function importFile() {
    if (ui.host) {
      const result = await ui.run(() =>
        ui.host!.importCourses({ kind: "file", operationId: operationId() }),
      );
      if (result) receive(result);
    }
  }
  async function importImage() {
    if (!ui.host) return;
    const image = await ui.run(() => ui.host!.selectImage());
    if (!image) return;
    const result = await ui.run(() =>
      ui.host!.importCourses({
        kind: "image",
        operationId: operationId(),
        imageDataUrl: image.imageDataUrl,
      }),
    );
    if (result) receive(result);
  }
  function parseRow(cells: string[], row: number): CourseInput {
    if (cells.some((c) => /^[=+@]/.test(c.trim())))
      throw Error(`第 ${row} 行含公式样式内容，请改成实际文字或数值`);
    const parity =
      ({ 全: "all", 单: "odd", 双: "even" } as Record<string, string>)[
        cells[6] ?? ""
      ] ?? cells[6];
    const parsed = CourseInputSchema.safeParse({
      title: cells[0],
      weekday: Number(cells[1]),
      startTime: cells[2],
      endTime: cells[3],
      firstWeek: Number(cells[4]),
      lastWeek: Number(cells[5]),
      parity,
      location: cells[7] ?? "",
      termStart: term,
      weeks: weeks[row]?.trim()
        ? weeks[row]!.split(/[,，、\s]+/)
            .filter(Boolean)
            .map(Number)
        : null,
    });
    if (!parsed.success)
      throw Error(
        `第 ${row} 行：${parsed.error.issues.map((i) => i.message).join("；")}`,
      );
    return parsed.data;
  }
  async function save() {
    try {
      const courses = rows.map((r) => parseRow(r.cells, r.row));
      if (!courses.length) throw Error("还没有可导入的课程");
      const result = await ui.mutate(
        courses.map((values) => ({ type: "create", entity: "course", values })),
      );
      if (result && result.status !== "clarification") {
        setPreview(null);
        setRows([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "请校对课程");
    }
  }
  function download() {
    const blob = new Blob(["\uFEFF" + headers.join(",") + "\r\n"], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "终极日历-课表模板.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
  const today = todayDate();
  const groups = [...snapshot.courses.reduce((map, course) => map.set(course.title, [...(map.get(course.title) ?? []), course]), new Map<string, typeof snapshot.courses>())]
    .map(([title, records]) => ({ title, records: records.sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime)) }));
  const used = occupiedColors(snapshot, today);
  const termStart = snapshot.settings.termStart;
  const week = termStart ? Math.floor(dayDistance(termStart, today) / 7) + 1 : null;
  const termLabel = week !== null && week >= 1 && week <= snapshot.settings.termWeeks ? `第 ${week} 周 / 共 ${snapshot.settings.termWeeks} 周` : "";
  /** A course's color follows its title, so every weekly record of it changes together. */
  const recolor = (title: string, hex: string) => ui.mutate(snapshot.courses.filter(c => c.title === title)
    .map(c => ({ type: "update" as const, entity: "course" as const, id: c.id, expectedVersion: c.version, scope: "all" as const, values: { color: hex as NonNullable<typeof c.color> } })));
  return (
    <div className="course-editor">
      <div className="a2-me-h">
        <h2>课程表</h2>
        <span className="ui-hint">{[termLabel, groups.length ? `${groups.length} 门课` : ""].filter(Boolean).join(" · ")}</span>
        {ui.host && <MoreMenu label="导入课表" trigger="导入课表" items={[
          { label: "导入 CSV / XLSX", disabled: ui.busy, onSelect: () => void importFile() },
          { label: "识别课表截图", disabled: ui.busy, onSelect: () => void importImage() },
          { label: "粘贴 CSV 文本", onSelect: () => setPasting(true) },
          { label: "下载空白模板", onSelect: download },
        ]} />}
        <button className="ui-btn" onClick={() => edit({ entity: "course" })}><Plus aria-hidden="true" />添加课程</button>
      </div>
      {pasting && ui.host && <div className="a2-me-paste">
        <label>粘贴模板 CSV 文本（星期用 1–7，时间为 HH:mm）
          <textarea aria-label="课表 CSV 文本" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="actions">
          <button className="ui-btn" disabled={!text.trim() || ui.busy} onClick={() => void ui.run(() => ui.host!.importCourses({ kind: "text", operationId: operationId(), text }), receive)}>生成校对预览</button>
          <button className="ui-btn ghost" onClick={() => setPasting(false)}>收起</button>
        </div>
      </div>}
      {preview && (
        <section className="course-preview">
          <h3>尚未导入 · 校对课程</h3>
          <p>{preview.message}</p>
          {preview.uncertainties.map((u, i) => (
            <p className="warning" key={i}>
              {u}
            </p>
          ))}
          {preview.sourceId && (
            <button onClick={() => openSource(preview.sourceId!)}>
              查看保留的课表原图
            </button>
          )}
          <label>
            第一教学周周一
            <input
              type="date"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>原行</th>
                  {headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th>指定周（可空）</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, index) => (
                  <tr key={r.row}>
                    <th>{r.row}</th>
                    {headers.map((h, column) => (
                      <td key={h}>
                        <input
                          aria-label={`第${r.row}行${h}`}
                          value={r.cells[column] ?? ""}
                          onChange={(e) =>
                            setRows((values) =>
                              values.map((v, i) =>
                                i === index
                                  ? {
                                      ...v,
                                      cells: Array.from(
                                        { length: 8 },
                                        (_, n) =>
                                          n === column
                                            ? e.target.value
                                            : (v.cells[n] ?? ""),
                                      ),
                                    }
                                  : v,
                              ),
                            )
                          }
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        aria-label={`第${r.row}行指定周`}
                        placeholder="1,3,6"
                        value={weeks[r.row] ?? ""}
                        onChange={(e) =>
                          setWeeks({ ...weeks, [r.row]: e.target.value })
                        }
                      />
                    </td>
                    <td>
                      <button
                        onClick={() =>
                          setRows((values) =>
                            values.filter((_, i) => i !== index),
                          )
                        }
                      >
                        移除此行
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.map(
            (r) =>
              r.errors.length > 0 && (
                <details key={r.row} className="warning">
                  <summary>
                    第 {r.row} 行原识别问题（校对后保存时重新验证）
                  </summary>
                  {r.errors.map((e, i) => (
                    <p key={i}>{e}</p>
                  ))}
                </details>
              ),
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <footer className="form-footer">
            <button
              onClick={() => {
                setPreview(null);
                setRows([]);
              }}
            >
              取消导入
            </button>
            <button
              className="primary"
              disabled={ui.busy}
              onClick={() => void save()}
            >
              确认校对，保存课程
            </button>
          </footer>
        </section>
      )}
      {groups.length > 0 && <table className="a2-course-table">
        <thead><tr><th>颜色</th><th>课程</th><th>上课时间</th><th>地点</th><th>周次</th></tr></thead>
        <tbody>{groups.map(({ title, records }) => {
          const first = records[0]!, color = first.color;
          const others = [...used];
          if (color) others.splice(others.indexOf(color), 1);
          return <tr key={title}>
            <td><ColorPicker name={title} color={color} used={others} busy={ui.busy} pick={hex => void recolor(title, hex)} /></td>
            <td className="t"><button className="t" onClick={() => edit({ entity: "course", id: first.id })} title="编辑这门课">{title}</button></td>
            <td className="n">{records.map(c => <button key={c.id} className="a2-slot" onClick={() => edit({ entity: "course", id: c.id })} title="编辑这一节的系列">
              周{weekdays[c.weekday - 1]} {c.startTime}–{c.endTime}</button>)}</td>
            <td>{[...new Set(records.map(c => c.location).filter(Boolean))].join("、") || "—"}</td>
            <td className="n">{[...new Set(records.map(c => `${c.weeks ? `第 ${c.weeks.join("、")} 周` : `${c.firstWeek}–${c.lastWeek} 周`}${c.weeks ? "" : { all: "", odd: " · 单周", even: " · 双周" }[c.parity]}`))].join("；")}</td>
          </tr>;
        })}</tbody>
      </table>}
      {!snapshot.courses.length && !preview && (
        <div className="ui-empty">
          <h4>课表还是空的</h4>
          <p>{ui.host ? "从「导入课表」导入表格或截图，或者手动添加第一门课。" : "手动添加第一门课。"}</p>
        </div>
      )}
      {ui.error && (
        <p className="error" role="alert">
          {ui.error}
        </p>
      )}
    </div>
  );
}
