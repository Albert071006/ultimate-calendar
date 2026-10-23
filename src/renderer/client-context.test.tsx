// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SnapshotSchema, type DesktopAPI } from '../shared/contracts';
import { PLANNER_CLIENT_METHODS, type PlannerClient } from '../shared/client';
import { App } from './App';

afterEach(cleanup);

function desktop() {
  const snapshot = SnapshotSchema.parse({
    schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [],
    courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [],
    keyStatus: { configured: false, sessionOnly: false },
  });
  return {
    snapshot: vi.fn(async () => ({ ok: true, data: structuredClone(snapshot) })),
    onChanged: () => () => {}, onNavigate: vi.fn(() => () => {}),
    mutate: vi.fn(), undo: vi.fn(), command: vi.fn(),
  } as unknown as DesktopAPI;
}
const clientOnly = (api: DesktopAPI): PlannerClient =>
  Object.fromEntries(PLANNER_CLIENT_METHODS.map(method => [method, api[method]])) as PlannerClient;

it('renders the planner from a data client alone and hides host-only pages', async () => {
  const api = desktop();
  render(<App client={clientOnly(api)} />);
  expect(await screen.findByRole('button', { name: '待判断' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'QQ 采集' })).toBeNull();
  expect(screen.queryByRole('button', { name: '设置' })).toBeNull();
  expect(api.onNavigate).not.toHaveBeenCalled();
});

it('shows host pages and listens for tray navigation when the host is present', async () => {
  const api = desktop();
  render(<App api={api} />);
  expect(await screen.findByRole('button', { name: 'QQ 采集' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();
  expect(api.onNavigate).toHaveBeenCalled();
});

it('reads the preload bridge only through the connection module', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'client-context.tsx'
        && /window\.planner|ui\.api\b/.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
  };
  walk(join(__dirname));
  expect(offenders).toEqual([]);
});
