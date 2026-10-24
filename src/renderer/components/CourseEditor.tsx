import { useState } from "react";
import {
  CourseInputSchema,
  type CourseImportResult,
  type CourseInput,
  type Snapshot,
} from "../../shared/contracts";
import { operationId } from "../calendar-layout";
import type { PlannerUI } from "../hooks/usePlanner";
import type { EditorTarget } from "./editor/EntityEditor";
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
    [text, setText] = useState("");
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
  return (
    <div className="course-editor">
      <div className="section-heading">
        <div>
          <h3>课表与教学周</h3>
          <p>手动录入或导入，校对完成才写入日历。</p>
        </div>
        <button className="primary" onClick={() => edit({ entity: "course" })}>
          ＋ 新建课程
        </button>
      </div>
      <div className="toolbar wrap">
        <button onClick={() => void importFile()} disabled={ui.busy}>
          导入 CSV / XLSX
        </button>
        <button onClick={() => void importImage()} disabled={ui.busy}>
          识别课表截图
        </button>
        <button onClick={download}>下载空白模板</button>
      </div>
      <p className="hint">
        星期使用 1–7；时间必须为
        HH:mm。只有节次的截图，请在设置中填写节次时间并逐格校对。
      </p>
      <details>
        <summary>粘贴模板 CSV 文本</summary>
        <textarea
          aria-label="课表 CSV 文本"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          disabled={!text.trim() || ui.busy}
          onClick={() =>
            void ui.run(
              () =>
                ui.host!.importCourses({
                  kind: "text",
                  operationId: operationId(),
                  text,
                }),
              receive,
            )
          }
        >
          生成校对预览
        </button>
      </details>
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
      <div className="course-list">
        {snapshot.courses.map((c) => (
          <button
            className="course-row"
            key={c.id}
            onClick={() => edit({ entity: "course", id: c.id })}
          >
            <span className="course-badge">
              周{["一", "二", "三", "四", "五", "六", "日"][c.weekday - 1]}
            </span>
            <div>
              <strong>{c.title}</strong>
              <small>
                {c.startTime}–{c.endTime} · 第 {c.firstWeek}–{c.lastWeek} 周 ·{" "}
                {c.weeks
                  ? `指定 ${c.weeks.join("、")} 周`
                  : { all: "每周", odd: "单周", even: "双周" }[c.parity]}{" "}
                · {c.location || "地点未填"}
              </small>
            </div>
            <span>编辑系列 →</span>
          </button>
        ))}
        {!snapshot.courses.length && !preview && (
          <div className="empty-state">
            <h3>课表还是空的</h3>
            <p>导入模板、截图，或者手动填写第一门课。</p>
          </div>
        )}
      </div>
      {ui.error && (
        <p className="error" role="alert">
          {ui.error}
        </p>
      )}
    </div>
  );
}
