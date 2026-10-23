import type { DesktopAPI } from '../shared/contracts';
import type { HostCapabilities, PlannerClient } from '../shared/client';

export interface Connection { client?: PlannerClient; host?: HostCapabilities }

/** The only renderer module that reads the preload bridge. Explicit props win; a client without host stays host-less. */
export function resolveConnection(props: { api?: DesktopAPI; client?: PlannerClient; host?: HostCapabilities }): Connection {
  if (props.client || props.host) return { client: props.client, host: props.host };
  const api = props.api ?? window.planner;
  return { client: api, host: api };
}
