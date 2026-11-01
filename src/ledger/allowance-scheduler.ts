import type { LedgerService } from './service';

/** Calendar-month rules use the ledger's Beijing clock and durable monthly keys.
 * Polling also catches up after sleep or downtime without relying on a page read.
 */
export function startAllowanceScheduler(options: {
  ledger: Pick<LedgerService, 'ensureMonthlyAllowance'>;
  isIdle?(): boolean;
  onChanged(): void;
  onError(error: unknown): void;
}) {
  let stopped = false;
  const check = () => {
    if (stopped) return;
    try {
      if (options.isIdle?.() === false) return;
      if (options.ledger.ensureMonthlyAllowance()) options.onChanged();
    } catch (error) {
      // A failed check is retried; existing/voided/undone months remain protected
      // by the ledger even if notification or backup failed after the commit.
      try { options.onError(error); } catch { /* Diagnostics cannot stop future checks. */ }
    }
  };
  check();
  const timer = setInterval(check, 30_000);
  timer.unref();
  return { check, stop() { stopped = true; clearInterval(timer); } };
}
