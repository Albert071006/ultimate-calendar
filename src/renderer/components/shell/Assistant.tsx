import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import type { CommandRequest, CommandResult } from "../../../shared/contracts";
import { operationId } from "../../calendar-layout";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { Selection } from "../Calendar";
type ConversationEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: "pending" | "failed";
  request?: CommandRequest;
  outcome?: CommandResult['conversationState'];
};

/** One-line assistant at the bottom of every page; its conversation opens upward over the page. */
export function Assistant({ ui, selected, date, domain, ledgerView }: {
  ui: PlannerUI;
  selected: Selection | null;
  date: string;
  domain?: 'ledger';
  ledgerView?: CommandRequest['ledgerView'];
}) {
  const [text, setText] = useState(""),
    [history, setHistory] = useState<ConversationEntry[]>([]),
    [expanded, setExpanded] = useState(false),
    [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const conversation = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (conversation.current)
      conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [history, expanded]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setExpanded(true);
        input.current?.focus();
      } else if (event.key === "Escape" && root.current?.contains(document.activeElement)) {
        setExpanded(false);
        input.current?.blur();
      }
    };
    const outside = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setExpanded(false);
    };
    window.addEventListener("keydown", key);
    document.addEventListener("mousedown", outside);
    return () => { window.removeEventListener("keydown", key); document.removeEventListener("mousedown", outside); };
  }, []);

  async function execute(request: CommandRequest, replyId: string) {
    if (!ui.client || inFlight.current || ui.busy) return;
    inFlight.current = true;
    setRunning(true);
    setExpanded(true);
    setHistory(previous => previous.map(entry => entry.id === replyId
      ? { ...entry, text: "正在处理…", status: "pending", request }
      : entry));
    const result = await ui.run(() => ui.client!.command(request));
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
            ? "\n" + result.items.map(i => `${i.date} ${i.start?.slice(11, 16) ?? "标记"} ${i.title}`).join("\n")
            : ""),
      } : entry));
  }
  function send() {
    if (!ui.client || !text.trim() || inFlight.current || ui.busy) return;
    const id = operationId();
    const request: CommandRequest = {
      operationId: id,
      text,
      ...(domain ? { domain } : {}),
      ...(domain === 'ledger' && ledgerView ? { ledgerView } : {}),
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
    <section ref={root} className={`a2-assist${expanded ? " open" : ""}`} aria-label="生活助手">
      {expanded && (
        <div className="a2-assist-panel ui-overlay">
          <div className="a2-assist-head">
            <strong>生活助手</strong>
            <span className="ui-hint">{running ? "正在处理…" : selected ? "已携带选中事项" : "Esc 收起"}</span>
          </div>
          <div className="conversation" aria-live="polite" ref={conversation}>
            {history.length ? (
              history.map((entry) => (
                <p className={`message ${entry.role}`} key={entry.id} aria-busy={entry.status === "pending"}>
                  <small>{entry.role === "user" ? "你" : "助手"}</small>
                  {entry.text}
                  {entry.status === "failed" && entry.request && <>
                    {" "}<button className="ui-btn sm" disabled={running || ui.busy} onClick={() => void execute(entry.request!, entry.id)}>重试这条指令</button>
                  </>}
                </p>
              ))
            ) : (
              <p className="ui-hint">例如"明天下午有空吗""午饭 20 元，支付宝""这个月花了多少"。不明确的操作会继续询问，批量变更先预览。</p>
            )}
          </div>
        </div>
      )}
      <form className="a2-assist-bar" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <MessageSquare aria-hidden="true" />
        <textarea
          ref={input}
          aria-label="自然语言指令"
          rows={1}
          value={text}
          onFocus={() => setExpanded(true)}
          onChange={(e) => setText(e.target.value)}
          placeholder="说一句就行：周五晚上留两小时写报告"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        <span className="ui-kbd" aria-hidden="true">Ctrl K</span>
        <button type="button" className="ui-btn ghost icon" aria-label={expanded ? "收起对话" : "展开对话"} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
        </button>
        <button type="submit" className="ui-btn primary icon" disabled={running || ui.busy || !text.trim()} aria-label="发送指令" title={running ? "处理中…" : "发送"}>
          <ArrowRight aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}
