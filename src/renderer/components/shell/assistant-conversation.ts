import { useRef, useState } from "react";
import type { ApiError, CommandRequest, CommandResult, SelectedImage } from "../../../shared/contracts";
import { operationId } from "../../calendar-layout";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { Selection } from "../Calendar";
import type { ResourceReference } from '../../../shared/resources';
import { needsResourcePreparation, openCommandResources, prepareResourceCommand, redactResourcePaths } from '../../resource-command';
import { useAssistantImage } from './assistant-image-input';

export type ConversationEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: "pending" | "failed";
  request?: CommandRequest;
  outcome?: CommandResult['conversationState'];
  resources?: ResourceReference[];
  image?: SelectedImage;
  /** A persisted conversation never includes image bytes. */
  imageUnavailable?: boolean;
  /** Only a definitive pre-send failure can supply a later clarification; unknown results cannot. */
  delivery?: 'not-sent' | 'unknown';
};
export type UnsentClarificationDraft = { replyId: string; text: string };

/** A visible draft can be edited, but an uncertain request or an attachment must never be replayed implicitly. */
export function canContinueUnsent(entry: ConversationEntry): boolean {
  const request = entry.request, previous = request?.history?.at(-1);
  return entry.status === 'failed' && entry.delivery === 'not-sent' && !!request?.text.trim()
    && !request.image && !request.resources?.length && !needsResourcePreparation(request.text)
    && previous?.role === 'assistant' && previous.outcome?.phase === 'clarification';
}

function failureText(error: ApiError | undefined): string {
  if (!error) return '未能确认处理结果。请使用这条指令的重试按钮核对，不要另建重复指令。';
  if (error.delivery === 'unknown') return `结果待核对 · ${error.message}\n请使用这条指令的重试按钮核对，不要另建重复指令。`;
  return error.message;
}

/**
 * The assistant's conversation and command flow, shared by the desktop bar and the phone page: the user's
 * message shows at once, the reply slot says it is working, and a failed request retries only explicitly.
 */
export function useAssistantConversation({ ui, selected, date, domain, ledgerView, initial = [], initialDraft, onStart }: {
  ui: PlannerUI;
  selected: Selection | null;
  date: string;
  domain?: 'ledger';
  ledgerView?: CommandRequest['ledgerView'];
  initial?: ConversationEntry[];
  initialDraft?: UnsentClarificationDraft;
  /** Called when a request starts, e.g. to open the conversation. */
  onStart?: () => void;
}) {
  const [text, setText] = useState(initialDraft?.text ?? ""),
    [history, setHistory] = useState<ConversationEntry[]>(initial),
    [running, setRunning] = useState(false),
    [resources, setResources] = useState<ResourceReference[]>([]),
    [editingReplyId, setEditingReplyId] = useState<string | undefined>(initialDraft?.replyId);
  const composer = useRef(text);
  composer.current = text;
  const latestReplyId = useRef(history.at(-1)?.id);
  latestReplyId.current = history.at(-1)?.id;
  const inFlight = useRef(false);
  const imageInput = useAssistantImage(ui, () => inFlight.current || ui.busy);

  async function execute(request: CommandRequest, replyId: string) {
    if (!ui.client || inFlight.current || imageInput.reading.current || ui.busy) return;
    inFlight.current = true;
    setRunning(true);
    onStart?.();
    setHistory(previous => previous.map(entry => entry.id === replyId
      ? { ...entry, text: "正在处理…", status: "pending", request }
      : entry));
    let prepared: CommandRequest;
    try {
      const safe = needsResourcePreparation(request.text)
        ? await prepareResourceCommand(request.text, request.resources ?? [], ui.host)
        : { text: request.text, ...(request.resources?.length ? { resources: request.resources } : {}) };
      prepared = { ...request, ...safe, history: request.history?.map(entry => ({ ...entry, text: redactResourcePaths(entry.text) })) };
    } catch (error) {
      inFlight.current = false; setRunning(false);
      setHistory(previous => previous.map(entry => entry.id === replyId
        ? { ...entry, text: error instanceof Error ? `${error.message}。指令尚未发送。` : '资料位置未确认，指令尚未发送。', status: 'failed', delivery: 'not-sent', request }
        : entry));
      return;
    }
    setHistory(previous => previous.map(entry => entry.id === replyId ? { ...entry, request: prepared } : entry));
    let failure: ApiError | undefined;
    const result = await ui.run(async () => {
      try {
        const response = await ui.client!.command(prepared);
        if (!response.ok) failure = response.error;
        return response;
      } catch (error) {
        // A thrown transport error cannot establish whether the server received the request.
        failure = { code: 'NETWORK', message: error instanceof Error ? error.message : '资料服务连接中断', retryable: true, delivery: 'unknown' };
        throw error;
      }
    });
    if (!result) {
      inFlight.current = false;
      setRunning(false);
      const failed: ConversationEntry = { id: replyId, role: 'assistant', text: failureText(failure), status: 'failed',
        ...(failure?.delivery ? { delivery: failure.delivery } : {}), request: prepared };
      setHistory(previous => previous.map(entry => entry.id === replyId ? failed : entry));
      // The complete unsent text remains visible in the editor. Nothing is silently merged into history.
      if (canContinueUnsent(failed) && !composer.current.trim()) continueUnsent(failed);
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
    if (result.resourcesToOpen?.length) reply = await openCommandResources(result.resourcesToOpen, ui.host);
    inFlight.current = false;
    setRunning(false);
    // Keep unconsumed selections for a clarification such as “关联到哪项任务？”.
    if (mutation?.status === 'applied' || result.resourcesToOpen?.length) setResources([]);
    else if (prepared.resources?.length) setResources(prepared.resources);
    setHistory((previous) => previous.map(entry => entry.id === replyId ? {
        id: replyId,
        role: "assistant",
        ...(result.conversationState ? { outcome: result.conversationState } : {}),
        ...(result.resourcesToOpen?.length ? { resources: result.resourcesToOpen } : {}),
        text:
          reply +
          (result.items.length
            ? "\n" + result.items.map(i => `${i.date} ${i.start?.slice(11, 16) ?? "标记"} ${i.title}`).join("\n")
            : ""),
      } : entry));
  }
  function send() {
    const image = imageInput.currentImage.current;
    if (!ui.client || (!text.trim() && !image) || inFlight.current || imageInput.reading.current || ui.busy) return;
    const id = operationId();
    // Keep only successful pairs. An image from a failed turn must never leak into a later instruction.
    const successfulHistory = history.flatMap((entry, index) => {
      const reply = history[index + 1];
      return entry.role === 'user' && reply?.role === 'assistant' && !reply.status ? [entry, reply] : [];
    }).slice(-20);
    const lastImageId = image ? undefined : successfulHistory.findLast(entry => entry.role === 'user' && entry.image)?.id;
    const request: CommandRequest = {
      operationId: id,
      text,
      ...(image ? { image } : {}),
      ...(resources.length ? { resources } : {}),
      ...(domain ? { domain } : {}),
      ...(domain === 'ledger' && ledgerView ? { ledgerView } : {}),
      selected: selected ? [{ entity: selected.entity, id: selected.id }] : [],
      fromDate: date,
      toDate: date,
      // A failed request can only be resumed with its explicit retry action.
      // Do not turn its unsatisfied instruction into context for a different request.
      history: successfulHistory.map(({ id: entryId, role, text: message, outcome, image: priorImage, imageUnavailable }) => ({
        role, text: (imageUnavailable ? `[先前图片未保留，如需看图请重新选择图片]\n${message}` : message).slice(0, 10_000), ...(outcome ? { outcome } : {}),
        ...(entryId === lastImageId && priorImage ? { image: priorImage } : {}),
      })),
    };
    const replyId = `${id}:assistant`;
    latestReplyId.current = replyId;
    setHistory(previous => [...previous.map(entry => entry.id === editingReplyId
      ? { ...entry, request: undefined, text: `${entry.text}\n已在后续消息中重新编辑。` } : entry),
      { id: `${id}:user`, role: "user", text, ...(image ? { image } : {}) },
      { id: replyId, role: "assistant", text: "正在处理…", status: "pending", request },
    ]);
    setText("");
    composer.current = '';
    setEditingReplyId(undefined);
    imageInput.removeImage();
    void execute(request, replyId);
  }
  function continueUnsent(entry: ConversationEntry) {
    if (entry.id !== latestReplyId.current || !canContinueUnsent(entry) || inFlight.current || ui.busy || imageInput.currentImage.current || resources.length) return;
    setText(entry.request!.text);
    composer.current = entry.request!.text;
    setEditingReplyId(entry.id);
    onStart?.();
  }
  const unsentDraft = editingReplyId && text.trim() ? { replyId: editingReplyId, text } : undefined;
  return { text, setText, history, running, send, resources, setResources, ...imageInput, unsentDraft, continueUnsent,
    retry: (entry: ConversationEntry) => {
      if (!entry.request) return;
      if (editingReplyId === entry.id) {
        if (composer.current === entry.request.text) { setText(''); composer.current = ''; }
        setEditingReplyId(undefined);
      }
      void execute(entry.request, entry.id);
    } };
}
