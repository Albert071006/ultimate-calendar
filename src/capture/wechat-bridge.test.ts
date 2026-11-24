import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWechatBridgeFactory } from './wechat-bridge';
import { reserveWechatSession } from './wechat-session';
import type { BridgeHealth } from './bridge';
import type { CaptureBridge } from './service';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(predicate: () => boolean) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Synthetic reader did not finish'); }
function fixture(mode = 'normal') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'uc-wechat-bridge-'))), worker = join(root, 'worker.mjs'), marker = join(root, 'closed');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(worker, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const session = process.argv[process.argv.indexOf('--workdir') + 1];
let calls = 0;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line); calls++;
  if (${JSON.stringify(mode)} === 'hung' && request.action === 'groups') {
    writeFileSync(join(session, 'synthetic-plaintext'), String(process.pid));
    setInterval(() => {}, 1000); return;
  }
  const accountId = ${JSON.stringify(mode)} === 'changed' && calls > 1 ? 'wechat:wxid_other' : 'wechat:wxid_test';
  const data = request.action === 'status' ? {accountId,nickname:'合成微信'} : request.action === 'groups' ? [{id:'selected@chatroom',name:'合成群'}] : {messages:[{group_id:request.groupId,message_id:'s:123',time:1793100600,message:'合成消息'}],nextCursor:null,complete:false};
  const response = ${JSON.stringify(mode)} === 'logged-out' && calls > 1 ? {id:request.id,ok:false,error:{code:'NOT_LOGGED_IN',message:'PRIVATE_ERROR_NEVER_SHOW'}} : {id:request.id,ok:true,data};
  process.stdout.write(JSON.stringify(response)+'\\n');
});
lines.on('close', () => { writeFileSync(${JSON.stringify(marker)}, 'cache-cleaned'); });
`);
  let selected = true;
  const states: BridgeHealth[] = [];
  const bridge = createWechatBridgeFactory({ python: process.execPath, worker, workdir: root, requestTimeoutMs: mode === 'hung' ? 1000 : 2000, shutdownGraceMs: 350 })({ endpoint: '', token: '', expectedAccountId: 'wechat:wxid_test', isGroupSelected: (_account, group) => selected && group === 'selected@chatroom', onHealth: state => states.push(state) });
  cleanups.push(async () => { bridge.stop(); if (states.some(state => state.state === 'online')) await until(() => existsSync(marker)); });
  return { bridge, states, marker, root, unselect: () => { selected = false; } };
}

describe('private WeChat reader bridge', () => {
  it('keeps the session while the timed-out child is alive and removes its plaintext after forced exit', async () => {
    const f = fixture('hung');
    expect(await f.bridge.start()).toMatchObject({ online: true });
    const name = readdirSync(f.root, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.startsWith('session-'))!.name;
    const path = join(f.root, name), plaintext = join(path, 'synthetic-plaintext');
    await expect(f.bridge.getGroups()).rejects.toThrow('超时');
    const pid = Number(readFileSync(plaintext, 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await until(() => !existsSync(path) && !existsSync(path + '.owner.json'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reaps a verified orphan on startup while preserving live or unowned directories', async () => {
    const f = fixture();
    const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    expect(exited.status).toBe(0);
    const stale = reserveWechatSession(f.root), live = reserveWechatSession(f.root), foreign = reserveWechatSession(f.root), redirected = reserveWechatSession(f.root);
    for (const session of [stale, live, foreign, redirected]) {
      session.recordWorker(session === live ? process.pid : exited.pid);
      writeFileSync(join(session.path, 'canary'), 'synthetic');
      const file = session.path + '.owner.json', owner = JSON.parse(readFileSync(file, 'utf8'));
      owner.parentPid = exited.pid;
      if (session === foreign) owner.directoryId = '0:0';
      writeFileSync(file, JSON.stringify(owner));
    }
    const legacy = join(f.root, 'reader-unmarked'); mkdirSync(legacy); writeFileSync(join(legacy, 'canary'), 'synthetic');
    const moved = join(f.root, 'unrelated'); renameSync(redirected.path, moved);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(moved, redirected.path, linkType);
    symlinkSync(legacy, join(stale.path, 'nested-link'), linkType);
    expect(await f.bridge.start()).toMatchObject({ online: true });
    expect(existsSync(stale.path)).toBe(false); expect(existsSync(stale.path + '.owner.json')).toBe(false);
    for (const path of [legacy, live.path, foreign.path, redirected.path, moved]) expect(readFileSync(join(path, 'canary'), 'utf8')).toBe('synthetic');
  });
  it('starts without a token, gates groups, and allows EOF cleanup before process termination', async () => {
    const f = fixture(); expect(await f.bridge.start()).toMatchObject({ online: true, accountId: 'wechat:wxid_test' });
    expect(await f.bridge.getGroups()).toEqual([{ id: 'selected@chatroom', name: '合成群' }]);
    await expect(f.bridge.history('other@chatroom')).rejects.toThrow('未获准');
    expect((await f.bridge.history('selected@chatroom')).messages).toHaveLength(1);
    f.unselect(); await expect(f.bridge.history('selected@chatroom')).rejects.toThrow('未获准');
    f.bridge.stop(); await until(() => existsSync(f.marker));
  });

  it('stops on a changed account before reading groups or messages', async () => {
    const f = fixture('changed'); await f.bridge.start();
    await expect(f.bridge.getGroups()).rejects.toThrow('账号已改变');
    expect(f.states.at(-1)).toMatchObject({ online: false, state: 'account-mismatch' });
    await until(() => existsSync(f.marker));
  });

  it('does not leave a logged-out reader online or reveal raw worker exceptions', async () => {
    const f = fixture('logged-out'); await f.bridge.start();
    await expect(f.bridge.getGroups()).rejects.toThrow('暂时无法读取');
    expect(f.states.at(-1)).toMatchObject({ online: false, state: 'error' });
    expect(JSON.stringify(f.states)).not.toContain('PRIVATE_ERROR_NEVER_SHOW');
  });

  it('reports an absent optional runtime without breaking application startup', async () => {
    const bridge: CaptureBridge = createWechatBridgeFactory({ python: '', worker: '', workdir: '' })({ endpoint: '', token: '', isGroupSelected: () => false });
    expect(await bridge.start()).toMatchObject({ online: false, state: 'error', error: expect.stringContaining('尚未配置') });
    bridge.stop();
  });
});
