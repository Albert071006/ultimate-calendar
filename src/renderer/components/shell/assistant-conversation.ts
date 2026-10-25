import { useRef, useState } from "react";
import type { CommandRequest, CommandResult } from "../../../shared/contracts";
import { operationId } from "../../calendar-layout";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { Selection } from "../Calendar";

export type ConversationEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: "pending" | "failed";
  request?: CommandRequest;
  outcome?: CommandResult['conversationState'];
};

/**
 * The assistant's conversation and command flow, shared by the desktop bar and the phone page: the user's
 * message shows at once, the reply slot says it is working, and a failed request retries only explicitly.
 */
export function useAssistantConversation({ ui, selected, date, domain, ledgerView, initial = [], onStart }: {
  ui: PlannerUI;
  selected: Selection | null;
  date: string;
  domain?: 'ledger';
  ledgerView?: CommandRequest['ledgerView'];
  initial?: ConversationEntry[];
  /** Called when a request starts, e.g. to open the conversation. */
  onStart?: () => void;
}) {
  const [text, setText] = useState(""),
    [history, setHistory] = useState<ConversationEntry[]>(initial),
    [running, setRunning] = useState(false);
  const inFlight = useRef(false);

  async function execute(request: CommandRequest, replyId: string) {
    if (!ui.client || inFlight.current || ui.busy) return;
    inFlight.current = true;
    setRunning(true);
    onStart?.();
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
  return { text, setText, history, running, send, retry: (entry: ConversationEntry) => entry.request && void execute(entry.request, entry.id) };
}
