import type { ApiResult, DesktopAPI, MutationRequestInput, MutationResult } from './contracts';
import type { LedgerMutationRequest, LedgerMutationResult } from './ledger';

/** Planner data access usable by any interface that reaches the host: desktop IPC now, a remote adapter later. */
export const PLANNER_CLIENT_METHODS = [
  'snapshot', 'mutate', 'undo', 'command', 'importSource', 'analyzeSource', 'onChanged',
  'ledgerSnapshot', 'ledgerMutate', 'ledgerUndo',
] as const satisfies readonly (keyof DesktopAPI)[];
/** A durable phone draft is explicitly different from a committed server mutation. */
export interface QueuedWrite { status: 'queued'; requestId: string; message: string }
export type PlannerMutationResult = MutationResult | QueuedWrite;
export type PlannerClient = Omit<Pick<DesktopAPI, typeof PLANNER_CLIENT_METHODS[number]>, 'mutate' | 'ledgerMutate'> & {
  mutate(request: MutationRequestInput): Promise<ApiResult<PlannerMutationResult>>;
  ledgerMutate(request: LedgerMutationRequest): Promise<ApiResult<LedgerMutationResult | QueuedWrite>>;
};
/** Abilities only the Windows host has: files, credentials, backups, updates, QQ capture, tray navigation. */
export type HostCapabilities = Omit<DesktopAPI, typeof PLANNER_CLIENT_METHODS[number]>;
