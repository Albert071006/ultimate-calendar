import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWechatBridgeFactory } from './wechat-bridge';
import type { BridgeHealth } from './bridge';
import type { CaptureBridge } from './service';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(predicate: () => boolean) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Synthetic reader did not finish'); }
function fixture(mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'uc-wechat-bridge-')), worker = join(root, 'worker.mjs'), marker = join(root, 'closed');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(worker, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
let calls = 0;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line); calls++;
  const accountId = ${JSON.stringify(mode)} === 'changed' && calls > 1 ? 'wechat:wxid_other' : 'wechat:wxid_test';
  const data = request.action === 'status' ? {accountId,nickname:'合成微信'} : request.action === 'groups' ? [{id:'selected@chatroom',name:'合成群'}] : {messages:[{group_id:request.groupId,message_id:'s:123',time:1793100600,message:'合成消息'}],nextCursor:null,complete:false};
  const response = ${JSON.stringify(mode)} === 'logged-out' && calls > 1 ? {id:request.id,ok:false,error:{code:'NOT_LOGGED_IN',message:'PRIVATE_ERROR_NEVER_SHOW'}} : {id:request.id,ok:true,data};
  process.stdout.write(JSON.stringify(response)+'\\n');
});
lines.on('close', () => { writeFileSync(${JSON.stringify(marker)}, 'cache-cleaned'); });
`);
  let selected = true;
  const states: BridgeHealth[] = [];
  const bridge = createWechatBridgeFactory({ python: process.execPath, worker, workdir: root, requestTimeoutMs: 2000 })({ endpoint: '', token: '', expectedAccountId: 'wechat:wxid_test', isGroupSelected: (_account, group) => selected && group === 'selected@chatroom', onHealth: state => states.push(state) });
  cleanups.push(async () => { bridge.stop(); if (states.some(state => state.state === 'online')) await until(() => existsSync(marker)); });
  return { bridge, states, marker, unselect: () => { selected = false; } };
}

describe('private WeChat reader bridge', () => {
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
