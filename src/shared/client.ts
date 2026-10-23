import type { DesktopAPI } from './contracts';

/** Planner data access usable by any interface that reaches the host: desktop IPC now, a remote adapter later. */
export const PLANNER_CLIENT_METHODS = [
  'snapshot', 'mutate', 'undo', 'command', 'importSource', 'analyzeSource', 'onChanged',
  'ledgerSnapshot', 'ledgerMutate', 'ledgerUndo',
] as const satisfies readonly (keyof DesktopAPI)[];
export type PlannerClient = Pick<DesktopAPI, typeof PLANNER_CLIENT_METHODS[number]>;
/** Abilities only the Windows host has: files, credentials, backups, updates, QQ capture, tray navigation. */
export type HostCapabilities = Omit<DesktopAPI, typeof PLANNER_CLIENT_METHODS[number]>;
