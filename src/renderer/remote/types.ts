import type { ApiResult, MutationResult, Snapshot } from '../../shared/contracts';
import type { PlannerClient } from '../../shared/client';
import type { LedgerSnapshot } from '../../shared/ledger';
import type { RemoteIdentity, RemoteMethod, RemoteSession } from '../../shared/remote';

export type PairedSession = Extract<RemoteSession, { paired: true }>;
export type PendingStatus = 'queued' | 'sending' | 'uncertain' | 'conflict' | 'review' | 'failed' | 'blocked';
export interface PendingWrite {
  id: string;
  requestId: string;
  method: RemoteMethod;
  input: unknown;
  wireInput?: unknown;
  identity: RemoteIdentity;
  createdAt: string;
  status: PendingStatus;
  label: string;
  message: string;
  dependencies: string[];
  targets: string[];
  base: unknown;
  preview?: Extract<MutationResult, { status: 'preview' }>;
  result?: ApiResult<unknown>;
}
export interface OfflinePartition {
  session: PairedSession;
  snapshot: Snapshot | null;
  ledgers: Record<string, LedgerSnapshot>;
  cachedAt: string | null;
  queue: PendingWrite[];
  aliases: Record<string, string>;
  completed: string[];
  ledgerRevisions?: Record<string, { base: number; after: number }>;
}
export interface RemoteClientState {
  status: 'connecting' | 'online' | 'offline' | 'unpaired' | 'expired' | 'error';
  session: PairedSession | null;
  cachedAt: string | null;
  pending: readonly PendingWrite[];
  message: string;
  storageError: string;
}
export interface DeviceSummary { id: string; name: string; createdAt?: string; expiresAt?: string; current?: boolean }
/** Local recovery only. No credentials, and never an automatic replay input for another device/generation. */
export interface RecoveryArchive {
  id: string;
  createdAt: string;
  reason: string;
  identity: RemoteIdentity;
  device: { id: string; name: string };
  cachedAt: string | null;
  pending: PendingWrite[];
}
export type QueueResolution = 'discard' | 'retry' | 'use-local' | 'confirm';
export interface RemoteController {
  client: PlannerClient;
  getState(): RemoteClientState;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<void>;
  pair(code: string, name: string): Promise<void>;
  reconnect(): Promise<void>;
  resolve(id: string, action: QueueResolution): Promise<void>;
  logout(): Promise<void>;
  devices(): Promise<DeviceSummary[]>;
  revokeDevice(id: string): Promise<void>;
  request<T>(path: string, input?: unknown, method?: string): Promise<T>;
  clearCache(): Promise<void>;
  exportPending(): Promise<RecoveryArchive>;
  archivePending(): Promise<RecoveryArchive>;
  archives(): Promise<RecoveryArchive[]>;
  dispose(): void;
}
