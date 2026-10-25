import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { RemoteState } from './state';

const day = 86400_000;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-session-renew-'));
  cleanup.push(() => { const child = relative(tmpdir(), directory); if (!child || child.startsWith('..') || isAbsolute(child)) throw Error('Invalid fixture directory'); rmSync(directory, { recursive: true, force: true }); });
  const file = join(directory, 'state.sqlite'); let at = Date.parse('2030-01-01T00:00:00Z');
  const state = new RemoteState(file, () => at); cleanup.push(() => state.close());
  const session = state.pair(state.createPairingCode(), 'Synthetic phone');
  const inspect = new DatabaseSync(file); cleanup.push(() => inspect.close());
  const expires = () => inspect.prepare('SELECT expires FROM sessions WHERE id=?').get(session.device.id)?.expires;
  return { state, session, inspect, expires, file, advance: (amount: number) => { at += amount; }, now: () => at };
}

describe('bounded authenticated session renewal', () => {
  it('renews only in the final half of the lifetime and preserves authorization identity', () => {
    const f = fixture(), original = f.expires();
    f.inspect.exec('CREATE TABLE changed(count INTEGER NOT NULL); INSERT INTO changed VALUES(0); CREATE TRIGGER session_changed AFTER UPDATE ON sessions BEGIN UPDATE changed SET count=count+1; END;');
    f.advance(15 * day - 1);
    expect(f.state.renewSession(f.session.token)).toEqual({ device: f.session.device, csrfToken: f.session.csrfToken, renewed: false, expiresAt: new Date(Number(original)).toISOString() });
    expect(f.expires()).toBe(original);
    expect(f.inspect.prepare('SELECT count FROM changed').get()?.count).toBe(0);
    f.advance(1);
    expect(f.state.renewSession(f.session.token)).toEqual({ device: f.session.device, csrfToken: f.session.csrfToken, renewed: true, expiresAt: new Date(f.now() + 30 * day).toISOString() });
    expect(f.state.session(f.session.token)).toEqual({ device: f.session.device, csrfToken: f.session.csrfToken });
    for (let index = 0; index < 10; index++) expect(f.state.renewSession(f.session.token)?.renewed).toBe(false);
    expect(f.inspect.prepare('SELECT count FROM changed').get()?.count).toBe(1);
  });
  it('does not revive expired, missing, oversized or revoked credentials', () => {
    const f = fixture();
    expect(f.state.renewSession(undefined)).toBeNull(); expect(f.state.renewSession('x'.repeat(201))).toBeNull();
    expect(f.state.renewSession('synthetic-invalid-token')).toBeNull();
    f.advance(30 * day);
    expect(f.state.renewSession(f.session.token)).toBeNull(); expect(f.state.session(f.session.token)).toBeNull();
    const current = f.state.pair(f.state.createPairingCode(), 'Synthetic replacement'); f.advance(16 * day);
    f.state.revoke(current.device.id);
    expect(f.state.renewSession(current.token)).toBeNull(); expect(f.state.devices()).toEqual([]);
  });
  it('rolls back a failed storage update without extending authorization', () => {
    const f = fixture(), expires = f.expires(); f.advance(16 * day);
    f.inspect.exec("CREATE TRIGGER reject_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'Synthetic write failure'); END;");
    expect(() => f.state.renewSession(f.session.token)).toThrow('Synthetic write failure');
    expect(f.expires()).toBe(expires); expect(f.state.session(f.session.token)?.device.id).toBe(f.session.device.id);
    f.inspect.exec('DROP TRIGGER reject_session_update');
    expect(f.state.renewSession(f.session.token)?.renewed).toBe(true);
  });
  it('persists the renewed expiry across reopening without creating another device', () => {
    const f = fixture(); f.advance(16 * day); expect(f.state.renewSession(f.session.token)?.renewed).toBe(true);
    f.advance(15 * day);
    const reopened = new RemoteState(f.file, f.now, false); cleanup.push(() => reopened.close());
    expect(reopened.session(f.session.token)).toEqual({ device: f.session.device, csrfToken: f.session.csrfToken });
    expect(reopened.devices()).toEqual([f.session.device]);
    f.advance(15 * day);
    expect(reopened.renewSession(f.session.token)).toBeNull();
  });
  it('lets the rate-limited public entrance reject guesses without exhausting the owner code', () => {
    const f = fixture(), code = f.state.createPairingCode();
    for (let count = 0; count < 20; count++) expect(() => f.state.pair('synthetic-invalid-code', 'Stranger', { countAttempt: false })).toThrow('配对码不正确');
    expect(f.state.pair(code, 'Owner', { countAttempt: false }).device.name).toBe('Owner');
  });
  it('keeps the legacy attempt limit and never bypasses an already locked code', () => {
    const f = fixture(), code = f.state.createPairingCode();
    for (let count = 0; count < 10; count++) expect(() => f.state.pair('synthetic-invalid-code', 'Stranger')).toThrow('配对码不正确');
    expect(() => f.state.pair(code, 'Owner', { countAttempt: false })).toThrow('配对码已失效或尝试过多');
  });
});
