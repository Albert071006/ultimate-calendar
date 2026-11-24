import { commandImages, hasCommandAttachments, type CommandIntent, type CommandRequest } from './contracts';
import { isLedgerClarificationAnswer, pendingClarificationHistory } from './command-continuation';

type Turn = NonNullable<CommandRequest['history']>[number];
type Action = Extract<CommandIntent['kind'], 'ledger' | 'mutate' | 'undo' | 'resource_open'>;
const describesOnly = /解释|解读|查看|看[看下]|查询|查一下|读出|读一下|什么意思|是什么|多少钱|(?:如何|怎么|是否|有没有|能否|是不是).{0,10}(?:记[账帐]|入[账帐])|(?:记[账帐]|入[账帐])(?:了吗|了没|了么|方法|流程)/;
const declinesAction = /(?:不(?:要|用|必|想|需要)?|别|无需|禁止|取消).{0,8}(?:记[账帐]|记录|入[账帐]|录入|保存|安排|添加|创建|撤销|打开)/;
const receiptReference = /(?:[这那该上](?:一)?(?:张|份|些|几张|个)?|(?:按照?|根据|照着?|用)(?:刚才|之前|上面)?(?:发的)?|刚才(?:发的)?|上(?:一张|面的?))(?:收据|小票|截图|图片|图|票据|账单|附件|文件)|(?:图(?:片)?|小票|收据)(?:里|上|中)(?:面|的)?/;
const bookingAnswer = /^(?:请|帮我)?记[账帐][。！!\s]*$/;
const book = /(?:^|\s|请|帮我|替我|给我|我要|直接|继续)(?:记[账帐]|入[账帐]|记(?:下|上|一笔))|(?:按|照|根据|把|将).{0,45}(?:记[账帐]|入[账帐]|记(?:下|上|一笔|到.{0,8}[账帐]))(?:[！!\s]|$)|(?:登记|记录|录入|补记|记一下).{0,18}(?:消费|收支|支出|收入|付款|交易|报销|账单)|(?:消费|支出|收入|收支|交易|报销).{0,12}(?:记录|登记|记一下)/;

/** Only user text can authorize an operation. A question from the assistant
 * (including one classified as a ledger clarification) supplies no authority. */
function requestedAction(text: string): Action | 'read' | undefined {
  let action: Action | undefined, read = false;
  for (const clause of text.split(/[，,。；;\n]|然后|并且/)) {
    if (declinesAction.test(clause)) return 'read';
    if (describesOnly.test(clause) || /[?？]|(?:是谁|是哪|是否|指什么|吗)[。！!\s]*$/.test(clause)) { read = true; continue; }
    if (/撤销|撤回/.test(clause)) action = 'undo';
    else if (book.test(clause)) action = 'ledger';
    else if (/安排|创建|添加|新建|提醒我|排进|排入|加入日历|导入课表/.test(clause)) action = 'mutate';
    else if (/打开/.test(clause)) action = 'resource_open';
  }
  return action ?? (read ? 'read' : undefined);
}

export function pendingAttachmentAction(request: CommandRequest): Action | undefined {
  const pending = pendingClarificationHistory(request);
  for (let index = pending.length - 2; index >= 0; index -= 2) {
    const turn = pending[index]!;
    const action = requestedAction(turn.text);
    if (action === 'read') return;
    if (action) return action;
    // Only an answer can connect this clarification to an earlier instruction.
    if (turn.text && !isLedgerClarificationAnswer({ text: turn.text, history: pending.slice(0, index) })) return;
  }
}

export function readOnlyAttachmentTurn(request: CommandRequest): boolean {
  return (hasCommandAttachments(request) || receiptReference.test(request.text)) &&
    requestedAction(request.text) === 'read';
}

/** Starting another booking after an attachment also retires any amounts the
 * user mentioned while discussing that attachment. */
export function ledgerEvidenceHistory(request: CommandRequest): Turn[] {
  const pending = pendingClarificationHistory(request);
  let sawAttachment = false, start = 0;
  for (let index = 0; index <= pending.length; index += 2) {
    const turn = pending[index] ?? request;
    if (sawAttachment && requestedAction(turn.text) === 'ledger' && !receiptReference.test(turn.text) && !bookingAnswer.test(turn.text)) start = index;
    if (hasCommandAttachments(turn)) sawAttachment = true;
  }
  return pending.slice(start);
}

function lastViewedReceipt(history: Turn[], boundary: number): Turn | undefined {
  for (let index = boundary - 1; index >= 1; index -= 2) {
    const reply = history[index]!, user = history[index - 1]!;
    if (reply.role !== 'assistant' || reply.outcome?.phase !== 'query' || user.role !== 'user') return;
    if (hasCommandAttachments(user)) return user;
    if (!receiptReference.test(user.text)) return;
  }
}

/** A query may identify a receipt without granting permission to book it.
 * A later explicit reference selects that turn. A fresh transaction, a saved
 * result or a topic change cannot inherit its pixels as amount evidence. */
export function ledgerReceiptTurn(request: CommandRequest): Turn | CommandRequest | undefined {
  if (hasCommandAttachments(request)) return request;
  const history = request.history ?? [];
  const pending = ledgerEvidenceHistory(request);
  const users = [...pending.filter(turn => turn.role === 'user'), request];
  const boundary = history.length - pending.length;
  let available = receiptReference.test(users[0]!.text) ? lastViewedReceipt(history, boundary) : undefined;
  let selected: Turn | undefined;
  let booking = false;
  for (const turn of users) {
    const action = requestedAction(turn.text);
    if (action) booking = action === 'ledger';
    if (hasCommandAttachments(turn) && 'role' in turn) {
      available = turn;
      selected = booking ? turn : undefined;
    } else if (action === 'ledger' && (receiptReference.test(turn.text) || pending.length && bookingAnswer.test(turn.text))) {
      // A singular pointer cannot disambiguate multiple historical originals.
      const count = available ? commandImages(available).length + (available.documents?.length ?? 0) : 0;
      selected = count > 1 && /(?:这|那|上)(?:一)?(?:张|份)/.test(turn.text) ? undefined : available;
    } else if (action) {
      selected = available = undefined;
    }
  }
  return selected;
}

export function ledgerAttachmentHistory(request: CommandRequest): CommandRequest['history'] {
  if (readOnlyAttachmentTurn(request)) return request.history;
  const receipt = ledgerReceiptTurn(request);
  return request.history?.map(turn => {
    if (turn === receipt || !hasCommandAttachments(turn)) return turn;
    const { image: _image, images: _images, documents: _documents, ...textTurn } = turn;
    return textTurn;
  });
}
