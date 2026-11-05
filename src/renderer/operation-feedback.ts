import type { PlannerUI } from './hooks/usePlanner';

/** Older hosts/test clients can still expose the original global busy flag. */
export function operationPending(ui: PlannerUI, target: string | string[]): boolean {
  return ui.isPending?.(target) ?? ui.busy;
}
