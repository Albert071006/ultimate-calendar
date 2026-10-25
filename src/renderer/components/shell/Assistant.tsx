import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import type { CommandRequest } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { Selection } from "../Calendar";
import { useAssistantConversation } from "./assistant-conversation";

/** One-line assistant at the bottom of every page; its conversation opens upward over the page. */
export function Assistant({ ui, selected, date, domain, ledgerView }: {
  ui: PlannerUI;
  selected: Selection | null;
  date: string;
  domain?: 'ledger';
  ledgerView?: CommandRequest['ledgerView'];
}) {
  const [expanded, setExpanded] = useState(false);
  const { text, setText, history, running, send, retry } = useAssistantConversation({ ui, selected, date, domain, ledgerView, onStart: () => setExpanded(true) });
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
                    {" "}<button className="ui-btn sm" disabled={running || ui.busy} onClick={() => retry(entry)}>重试这条指令</button>
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
