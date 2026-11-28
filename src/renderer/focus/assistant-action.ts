import type { CommandRequest, FocusAction } from '../../shared/contracts';
import type { FocusControls } from './FocusProvider';

/** Serialize the localStorage claim across tabs on LAN origins where Web Locks are unavailable. */
function withDatabaseLock(key: string, deliver: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('ultimate-calendar-focus-receipts', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('locks');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('locks', 'readwrite');
      let result: string;
      // The readwrite transaction owns this store exclusively during the synchronous claim and timer update.
      transaction.objectStore('locks').get(key).onsuccess = () => { result = deliver(); };
      transaction.oncomplete = () => { db.close(); resolve(result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

/** Claim the original command before any device effect. History stores display text only. */
export async function deliverFocusAction(request: CommandRequest, action: FocusAction, current: () => FocusControls | null) {
  const key = 'ultimate-calendar:focus-receipt:' + request.operationId;
  function deliver() {
    const timer = current();
    if (!timer || request.focusTimer === undefined) return '当前资料已切换或计时器不可用，请在本机重新发起。';
    try {
      if (localStorage.getItem(key) !== null) return '这条计时指令已处理。';
      localStorage.setItem(key, '1');
    } catch { return '本机无法保存计时回执，请使用专注面板操作。'; }
    if (action.type === 'start') {
      const { type: _type, ...draft } = action;
      return timer.requestStart(draft) === 'conflict'
        ? '本机已有进行中的计时，请在专注面板选择保存并切换、放弃并切换，或继续当前计时。'
        : '已开始「' + action.title + '」的' + (action.mode === 'pomodoro' ? '番茄倒计时。' : '正向计时。');
    }
    const state = timer.getStatus();
    const original = request.focusTimer;
    if (!state || !original || state.timerId !== (action.timerId ?? original.timerId)) return '原计时已经结束或切换，请核对当前计时。';
    if (state.phase.startsWith('break') !== original.phase.startsWith('break')) return '计时阶段已经改变，请核对当前计时。';
    if (state.switching) { timer.show(); return '请先在专注面板处理当前的切换选择。'; }
    if (action.type === 'pause' && ['running','breakRunning'].includes(state.phase)) { timer.pause(); return '已暂停「' + state.title + '」。'; }
    if (action.type === 'resume' && ['paused','breakPaused'].includes(state.phase)) { timer.resume(); return '已继续「' + state.title + '」。'; }
    if (action.type === 'finish' && ['running','paused','breakRunning','breakPaused'].includes(state.phase)) {
      timer.finish();
      if (state.phase.startsWith('break')) return '本次休息已结束。';
      return timer.getStatus() ? '本次计时已结束，请在专注面板选择是否保存。' : '专注不足 1 分钟，本次未保存。';
    }
    return '当前阶段无需执行这条计时指令。';
  }
  const lock = 'ultimate-calendar:assistant-timer:' + current()?.scope;
  try { return navigator.locks ? await navigator.locks.request(lock, deliver) : await withDatabaseLock(lock, deliver); }
  catch { return '本机未能确认计时结果，请查看专注面板。'; }
}
