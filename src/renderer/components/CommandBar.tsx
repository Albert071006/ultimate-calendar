import { useEffect, useRef, useState } from "react";
import type { CommandRequest, CommandResult } from "../../shared/contracts";
import { operationId } from "../calendar-layout";
import type { PlannerUI } from "../hooks/usePlanner";
import type { Selection } from "./Calendar";
type ConversationEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: "pending" | "failed";
  request?: CommandRequest;
  outcome?: CommandResult['conversationState'];
};
export function CommandBar({
  ui,
  selected,
  date,
  domain,
}: {
  ui: PlannerUI;
  selected: Selection | null;
  date: string;
  domain?: 'ledger';
}) {
  const [text, setText] = useState(""),
    [history, setHistory] = useState<ConversationEntry[]>([]),
    [expanded, setExpanded] = useState(false),
    [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const conversation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conversation.current)
      conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [history, expanded]);

  async function execute(request: CommandRequest, replyId: string) {
    if (!ui.api || inFlight.current || ui.busy) return;
    inFlight.current = true;
    setRunning(true);
    setExpanded(true);
    setHistory(previous => previous.map(entry => entry.id === replyId
      ? { ...entry, text: "正在处理…", status: "pending", request }
      : entry));
    const result = await ui.run(() => ui.api!.command(request));
    inFlight.current = false;
    setRunning(false);
    if (!result) {
      setHistory(previous => previous.map(entry => entry.id === replyId
        ? { ...entry, text: "未收到处理结果，可以重试这条指令。", status: "failed", request }
        : entry));
      return;
    }
    const mutation = result.mutationResult;
    let reply = result.reply;
    if (mutation) {
      ui.receive(mutation);
      reply =
        mutation.status === "applied"
          ? `已执行 · ${mutation.message}\n${result.reply}`
          : mutation.status === "preview"
            ? `尚未执行 · 请核对预览后确认。\n${mutation.message}`
            : `尚未执行 · ${mutation.questions.join("；")}`;
    }
    setHistory((previous) => previous.map(entry => entry.id === replyId ? {
        id: replyId,
        role: "assistant",
        ...(result.conversationState ? { outcome: result.conversationState } : {}),
        text:
          reply +
          (result.items.length
            ? "\n" +
              result.items
                .map(
                  (i) =>
                    `${i.date} ${i.start?.slice(11, 16) ?? "标记"} ${i.title}`,
                )
                .join("\n")
            : ""),
      } : entry));
  }
  function send() {
    if (!ui.api || !text.trim() || inFlight.current || ui.busy) return;
    const id = operationId();
    const request: CommandRequest = {
      operationId: id,
      text,
      ...(domain ? { domain } : {}),
      selected: selected ? [{ entity: selected.entity, id: selected.id }] : [],
      fromDate: date,
      toDate: date,
      // A failed request can only be resumed with its explicit retry action.
      // Do not turn its unsatisfied instruction into context for a different request.
      history: history.flatMap((entry, index) => {
        const reply = history[index + 1];
        return entry.role === "user" && reply?.role === "assistant" && !reply.status
          ? [entry, reply].map(({ role, text: message, outcome }) => ({
            role, text: message.slice(0, 10_000), ...(outcome ? { outcome } : {}),
          }))
          : [];
      }).slice(-20),
    };
    const replyId = `${id}:assistant`;
    setHistory(previous => [...previous,
      { id: `${id}:user`, role: "user", text },
      { id: replyId, role: "assistant", text: "正在处理…", status: "pending", request },
    ]);
    setText("");
    void execute(request, replyId);
  }
  return (
    <section
      className={`command-bar ${expanded ? "expanded" : ""}`}
      aria-label="智能助手"
    >
      <div className="command-top">
        <span className="assistant-emblem">✧</span>
        <strong>生活助手</strong>
        <span className="fine-print">
          {running
            ? "正在处理…"
            : selected
              ? "已携带选中事项"
              : "中文查询与操作"}
        </span>
        <button onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起对话" : "展开对话"}
        </button>
      </div>
      {expanded && (
        <div className="conversation" aria-live="polite" ref={conversation}>
          {history.length ? (
            history.map((entry) => (
              <p className={`message ${entry.role}`} key={entry.id} aria-busy={entry.status === "pending"}>
                <small>{entry.role === "user" ? "你" : "助手"}</small>
                {entry.text}
                {entry.status === "failed" && entry.request && <>
                  {" "}<button disabled={running || ui.busy} onClick={() => void execute(entry.request!, entry.id)}>重试这条指令</button>
                </>}
              </p>
            ))
          ) : (
            <p className="hint">
              例如：“查看明天的空闲时间”“午饭 20 元，支付宝”“这个月花了多少”。不明确的操作会继续询问，日历批量变更先预览。
            </p>
          )}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="自然语言指令"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="安排时间、记一笔，或查询账单…"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="submit"
          className="primary"
          disabled={running || ui.busy || !text.trim()}
          aria-label="发送指令"
        >
          {running ? "处理中…" : "发送 ↗"}
        </button>
      </form>
    </section>
  );
}
