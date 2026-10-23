import { useState } from "react";
import type {
  CourseImportResult,
  SelectedImage,
  Source,
} from "../../shared/contracts";
import { displayInstant, operationId } from "../calendar-layout";
import type { PlannerUI } from "../hooks/usePlanner";
export function ImportDialog({
  ui,
  onClose,
  settings,
}: {
  ui: PlannerUI;
  onClose: () => void;
  settings: () => void;
}) {
  const [kind, setKind] = useState<"text" | "image">("text"),
    [text, setText] = useState(""),
    [label, setLabel] = useState(""),
    [sentAt, setSentAt] = useState(""),
    [image, setImage] = useState<SelectedImage | null>(null),
    [saved, setSaved] = useState<Source | null>(null);
  async function save(analyze: boolean) {
    if (!ui.client) return;
    const source =
      saved ??
      (await ui.run(() =>
        ui.client!.importSource({
          operationId: operationId(),
          source: {
            kind,
            text,
            label,
            sentAt: sentAt ? `${sentAt}:00+08:00` : null,
            imageDataUrl:
              kind === "image" ? (image?.imageDataUrl ?? null) : null,
          },
        }),
      ));
    if (!source) return;
    setSaved(source);
    ui.setNotice("来源已保存在本机");
    if (analyze) {
      const result = await ui.run(
        () =>
          ui.client!.analyzeSource({
            operationId: operationId(),
            sourceId: source.id,
          }),
        (r) => ui.setNotice(r.message),
      );
      if (result) onClose();
    } else onClose();
  }
  return (
    <div className="editor-form">
      <p className="hint">
        先保存原文，再由你明确提交
        DeepSeek。缺少发送时间时，相对日期会留待确认。
      </p>
      <div className="tabs">
        <button
          className={kind === "text" ? "selected" : ""}
          onClick={() => {
            setKind("text");
            setSaved(null);
          }}
        >
          粘贴文字
        </button>
        {ui.host && <button
          className={kind === "image" ? "selected" : ""}
          onClick={() => {
            setKind("image");
            setSaved(null);
          }}
        >
          消息截图
        </button>}
      </div>
      <label>
        群 / 来源标签
        <input
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            setSaved(null);
          }}
          placeholder="例如：课程通知群"
        />
      </label>
      <label>
        实际发送时间（可留空）
        <input
          type="datetime-local"
          value={sentAt}
          onChange={(e) => {
            setSentAt(e.target.value);
            setSaved(null);
          }}
        />
      </label>
      {kind === "text" ? (
        <label>
          原始消息
          <textarea
            rows={10}
            maxLength={100000}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(null);
            }}
            placeholder="保留原文，便于核对行动、收益和时间。"
          />
        </label>
      ) : (
        <div>
          <button
            onClick={() =>
              void ui.run(
                () => ui.host!.selectImage(),
                (selected) => {
                  if (selected) {
                    setImage(selected);
                    setSaved(null);
                    if (!label) setLabel(selected.label);
                  }
                },
              )
            }
          >
            选择 PNG / JPEG 截图
          </button>
          {image && (
            <img
              className="source-image"
              src={image.imageDataUrl}
              alt="所选消息截图"
            />
          )}
        </div>
      )}
      {saved && <p className="success">原文已保存，可在导入记录重试。</p>}
      {!ui.snapshot?.keyStatus.configured && (
        <div className="warning">
          DeepSeek 尚未配置。你可以先保存原文。
          <button onClick={settings}>前往设置密钥</button>
        </div>
      )}
      {ui.error && (
        <p role="alert" className="error">
          {ui.error}
        </p>
      )}
      <footer className="form-footer">
        <button onClick={onClose}>取消</button>
        <button
          disabled={
            ui.busy ||
            (!text.trim() && kind === "text") ||
            (!image && kind === "image")
          }
          onClick={() => void save(false)}
        >
          仅保存原文
        </button>
        <button
          className="primary"
          disabled={
            ui.busy ||
            (!text.trim() && kind === "text") ||
            (!image && kind === "image")
          }
          onClick={() => void save(true)}
        >
          保存并提交 AI 分析
        </button>
      </footer>
    </div>
  );
}
export function SourceViewer({
  source,
  ui,
  onClose,
  courses,
  settings,
  onCapture,
}: {
  source: Source;
  ui: PlannerUI;
  onClose: () => void;
  courses: (r: CourseImportResult) => void;
  settings: () => void;
  onCapture?: (reference: NonNullable<Source['captureRef']>) => void;
}) {
  const [ack, setAck] = useState(false);
  async function retry() {
    if (!ui.client || source.captureRef) return;
    if (source.purpose === "courses") {
      if (!ui.host) return;
      const r = await ui.run(() =>
        ui.host!.importCourses({
          kind: "source",
          operationId: operationId(),
          sourceId: source.id,
        }),
      );
      if (r) courses(r);
    } else
      await ui.run(
        () =>
          ui.client!.analyzeSource({
            operationId: operationId(),
            sourceId: source.id,
          }),
        (r) => ui.setNotice(r.message),
      );
  }
  return (
    <div className="editor-form">
      <p>
        {source.captureRef ? 'QQ 采集依据' : source.purpose === "courses" ? "课表截图原件" : "消息原件"} ·{" "}
        {source.label || "无标签"}
      </p>
      <dl className="source-metadata">
        <dt>发送时间</dt>
        <dd>
          {displayInstant(source.sentAt)}
          {!source.sentAt && " · 不能用导入时间替代"}
        </dd>
        <dt>导入时间</dt>
        <dd>{displayInstant(source.importedAt)}</dd>
        <dt>处理状态</dt>
        <dd>
          {
            {
              saved: "已保存，待提交",
              processing: "处理中",
              failed: "失败，可重试",
              succeeded: "完成",
              "needs-review": "需要校对",
            }[source.status]
          }
        </dd>
      </dl>
      {source.captureRef && <section className="capture-source-reference">
        <dl className="source-metadata"><dt>来源群</dt><dd>{source.captureRef.groupId}</dd><dt>依据位置</dt><dd>{source.captureRef.locator}</dd><dt>资料类型</dt><dd>{source.captureRef.transcribed ? 'AI 图片转写 · 请对照原件核对' : source.captureRef.attachmentId ? '附件提取正文' : '群消息文字'}</dd></dl>
        <p className="hint">以下是形成这条候选时保留的依据。原始群消息或附件可能随后更正、撤回或被清理，请在采集记录中核对。</p>
        {onCapture && <button onClick={() => onCapture(source.captureRef!)}>{source.captureRef.attachmentId ? '查看 QQ 原消息与附件位置' : '查看 QQ 原消息'}</button>}
        <p className="fine-print">需要重新分析时，请到 QQ 采集的分析批次中操作，以保留完整上下文和已完成进度。</p>
      </section>}
      {source.imageDataUrl && (
        <img
          className="source-image"
          src={source.imageDataUrl}
          alt="保留的原始截图"
        />
      )}
      {source.text && <pre className="original-text">{source.text}</pre>}
      {source.error && <p className="error">{source.error}</p>}
      {!ui.snapshot?.keyStatus.configured && (
        <button onClick={settings}>配置 DeepSeek 密钥</button>
      )}
      {!source.captureRef && <button
        className="primary"
        disabled={ui.busy || source.status === "processing"}
        onClick={() => void retry()}
      >
        {source.purpose === "courses"
          ? "重新识别并校对课表"
          : "提交 / 重试消息分析"}
      </button>}
      <fieldset className="warning">
        <legend>{source.captureRef ? '删除这份候选依据' : '删除原始资料'}</legend>
        <p>{source.captureRef ? '这会删除此处保留的候选依据。清理 QQ 群原文与附件，请到 QQ 采集页操作。' : '这会失去原文核对依据。关联摘要与独立任务会保留。'}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          我理解来源核对资料将被删除
        </label>
        <button
          className="danger"
          disabled={!ack || ui.busy}
          onClick={() =>
            void ui
              .mutate([
                {
                  type: "delete",
                  entity: "source",
                  id: source.id,
                  expectedVersion: source.version,
                  acknowledgeProvenanceLoss: true,
                },
              ])
              .then((r) => {
                if (r && r.status !== "clarification") onClose();
              })
          }
        >
          删除原文
        </button>
      </fieldset>
      {ui.error && (
        <p className="error" role="alert">
          {ui.error}
        </p>
      )}
    </div>
  );
}
