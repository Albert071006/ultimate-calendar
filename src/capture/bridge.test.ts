import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createReadOnlyBridge, detectExistingBridge, validateBridgeEndpoint, type BridgeHealth, type BridgeOptions, type ReadOnlyBridge } from './bridge';

const configFiles = vi.hoisted(() => ({ readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => configFiles);

type Packet = { action: string; params: Record<string, unknown>; echo: string };
type Fixture = Awaited<ReturnType<typeof fixture>>;
const bridges: ReadOnlyBridge[] = [];
const servers: WebSocketServer[] = [];
const account = '100001';
const group = '200001';
const message = (extra: Record<string, unknown> = {}) => ({ post_type: 'message', message_type: 'group', self_id: account, group_id: group, message_id: 'm-1', time: 1792700000, message: [{ type: 'text', data: { text: '合成测试通知' } }], ...extra });

async function fixture(handle?: (packet: Packet, socket: WebSocket) => boolean) {
  const actions: Packet[] = [], tokens: string[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  server.on('connection', (socket, request) => {
    tokens.push(request.headers.authorization ?? '');
    socket.on('message', value => {
      const packet = JSON.parse(value.toString()) as Packet;
      actions.push(packet);
      if (handle?.(packet, socket)) return;
      const data = packet.action === 'get_status' ? { online: true, good: true }
        : packet.action === 'get_login_info' ? { user_id: account, nickname: '合成账号' }
        : packet.action === 'get_group_list' ? [{ group_id: group, group_name: '合成测试群', member_count: 5 }]
        : packet.action === 'get_group_msg_history' ? { messages: [] } : {};
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: packet.echo }));
    });
  });
  await once(server, 'listening');
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const broadcast = (packet: unknown) => { for (const socket of server.clients) socket.send(typeof packet === 'string' ? packet : JSON.stringify(packet)); };
  return { server, endpoint, actions, tokens, broadcast };
}
function client(f: Fixture, options: Partial<BridgeOptions> = {}) {
  const bridge = createReadOnlyBridge({ endpoint: f.endpoint, token: 'synthetic-token', isGroupSelected: (a, g) => a === account && g === group,
    requestTimeoutMs: 500, reconnectMinMs: 30, reconnectMaxMs: 80, ...options });
  bridges.push(bridge);
  return bridge;
}
afterEach(async () => {
  for (const mock of Object.values(configFiles)) mock.mockReset();
  for (const bridge of bridges.splice(0)) bridge.stop();
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('calendar-owned bridge detection', () => {
  const directories = ['C:\\Software\\终极日历\\qq-bridge\\config', 'C:\\Software\\终极日历\\qq-bridge\\napcat\\config', 'C:\\Software\\终极日历\\qq-bridge\\snowluma\\config'];
  it('only reads calendar-owned directories and identifies SnowLuma by its dedicated directory', async () => {
    configFiles.readdir.mockResolvedValue(['onebot_100001.json', 'config.json', '..\\onebot_100002.json']);
    configFiles.stat.mockResolvedValue({ size: 128 });
    configFiles.readFile.mockImplementation(async (path: string) => JSON.stringify({ networks: { wsServers: [{ host: '127.0.0.1', port: path.includes('snowluma') ? 43132 : 43131, token: 'synthetic-calendar-token' }] } }));
    expect(await detectExistingBridge()).toEqual([
      { endpoint: 'ws://127.0.0.1:43131/', token: 'synthetic-calendar-token', source: 'NapCat', flavor: 'napcat' },
      { endpoint: 'ws://127.0.0.1:43132/', token: 'synthetic-calendar-token', source: 'SnowLuma', flavor: 'snowluma' },
    ]);
    expect(configFiles.readdir.mock.calls).toEqual(directories.map(directory => [directory]));
    expect(configFiles.stat.mock.calls).toEqual(directories.map(directory => [join(directory, 'onebot_100001.json')]));
    expect(configFiles.readFile.mock.calls).toEqual(directories.map(directory => [join(directory, 'onebot_100001.json'), 'utf8']));
  });

  it('returns no bridge when calendar configuration is absent, even if unrelated bot configuration exists', async () => {
    configFiles.readdir.mockImplementation(async (directory: string) => {
      if (directories.includes(directory)) throw new Error('ENOENT');
      return ['onebot_100001.json'];
    });
    configFiles.stat.mockResolvedValue({ size: 128 });
    configFiles.readFile.mockResolvedValue(JSON.stringify({ snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'unrelated-synthetic-token' }, networks: { wsServers: [{ host: '127.0.0.1', port: 3001, token: 'unrelated-synthetic-token' }] } }));
    expect(await detectExistingBridge()).toEqual([]);
    expect(configFiles.readdir.mock.calls).toEqual(directories.map(directory => [directory]));
    expect(configFiles.stat).not.toHaveBeenCalled();
    expect(configFiles.readFile).not.toHaveBeenCalled();
  });

  it('detects current NapCat onebot11 configuration with network.websocketServers', async () => {
    configFiles.readdir.mockImplementation(async (directory: string) => directory === directories[1] ? ['onebot11_100001.json', 'onebot11_default.json', '../onebot11_100002.json'] : []);
    configFiles.stat.mockResolvedValue({ size: 1024 });
    configFiles.readFile.mockResolvedValue(JSON.stringify({
      network: {
        httpServers: [{ enable: true, host: '127.0.0.1', port: 43130, token: 'synthetic-http-token' }],
        httpClients: [],
        websocketServers: [{ name: 'calendar', enable: true, host: '127.0.0.1', port: 43131,
          messagePostFormat: 'array', reportSelfMessage: false, token: 'synthetic-modern-token', enableForcePushEvent: true, debug: false, heartInterval: 30000 }],
        websocketClients: [{ enable: true, url: 'ws://127.0.0.1:43132', token: 'synthetic-reverse-token' }],
      }, musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
    }));
    expect(await detectExistingBridge()).toEqual([{ endpoint: 'ws://127.0.0.1:43131/', token: 'synthetic-modern-token', source: 'NapCat', flavor: 'napcat' }]);
    expect(configFiles.readdir.mock.calls).toEqual(directories.map(directory => [directory]));
    expect(configFiles.readFile.mock.calls).toEqual([[join(directories[1]!, 'onebot11_100001.json'), 'utf8']]);
  });

  it.each(['legacy', 'current'] as const)('rejects disabled, unauthenticated and non-loopback %s bridge configurations', async format => {
    configFiles.readdir.mockImplementation(async (directory: string) => directory === directories[0] ? [format === 'legacy' ? 'onebot_100001.json' : 'onebot11_100001.json'] : []);
    configFiles.stat.mockResolvedValue({ size: 1024 });
    const valid = { enable: true, host: '127.0.0.1', port: 43131, token: 'synthetic-valid-token' };
    const invalid = [
      { enable: false }, { enabled: false }, { enable: 'false' }, { enable: 0 },
      { token: '' }, { token: '   ' }, { token: undefined }, { token: null }, { token: 123 }, { token: 'line\nbreak' }, { token: 'x'.repeat(8193) },
      { host: '0.0.0.0' }, { host: '192.168.1.2' }, { host: 'example.invalid' }, { host: 'localhost.example.invalid' }, { host: '127.0.0.2' }, { host: ['127.0.0.1'] },
      { port: 0 }, { port: 65536 }, { port: true }, { port: '43131/extra' },
    ];
    const servers = [...invalid.map(change => ({ ...valid, ...change })),
      { ...valid, host: 'localhost', port: '43131' },
      { ...valid, host: '::1', port: 43132, token: undefined, accessToken: 'synthetic-legacy-token' },
    ];
    configFiles.readFile.mockResolvedValue(JSON.stringify(format === 'legacy' ? { networks: { wsServers: servers } } : { network: { websocketServers: servers } }));
    expect(await detectExistingBridge()).toEqual([
      { endpoint: 'ws://127.0.0.1:43131/', token: 'synthetic-valid-token', source: 'NapCat', flavor: 'napcat' },
      { endpoint: 'ws://[::1]:43132/', token: 'synthetic-legacy-token', source: 'NapCat', flavor: 'napcat' },
    ]);
  });
});

describe('read-only QQ bridge', () => {
  it('requires loopback and bearer authentication without query-string credentials', async () => {
    for (const endpoint of ['ws://example.com', 'http://127.0.0.1:3001', 'ws://127.0.0.1/?access_token=secret', 'ws://secret@127.0.0.1', 'ws://127.0.0.2:3001']) expect(() => validateBridgeEndpoint(endpoint)).toThrow();
    expect(validateBridgeEndpoint('ws://localhost:3001')).toBe('ws://127.0.0.1:3001/');
    expect(() => createReadOnlyBridge({ endpoint: 'ws://127.0.0.1:3001', token: '', isGroupSelected: () => false })).toThrow();
    const f = await fixture(), bridge = client(f);
    expect(await bridge.start()).toMatchObject({ online: true, nickname: '合成账号' });
    expect(f.tokens).toEqual(['Bearer synthetic-token']);
    expect(JSON.stringify(bridge.status())).not.toContain('synthetic-token');
    expect(await bridge.getGroups()).toEqual([{ id: group, name: '合成测试群', memberCount: 5 }]);
    expect((bridge as unknown as Record<string, unknown>).call).toBeUndefined();
    expect((bridge as unknown as Record<string, unknown>).request).toBeUndefined();
    expect(f.actions.map(p => p.action)).toEqual(['get_status', 'get_login_info', 'get_group_list']);
  });

  it('does not mistake a connected socket or cached login info for an online account', async () => {
    const f = await fixture((packet, socket) => {
      if (packet.action !== 'get_status') return false;
      socket.send(JSON.stringify({ status: 'ok', data: { online: false }, echo: packet.echo })); return true;
    });
    const received: unknown[] = [], bridge = client(f, { onMessage: value => received.push(value) });
    expect(await bridge.start()).toMatchObject({ connected: true, online: false, state: 'offline', accountId: null });
    f.broadcast(message());
    await expect(bridge.getGroups()).rejects.toThrow('尚未确认在线');
    expect(received).toEqual([]);
  });

  it('filters private messages and unselected groups before callbacks and provenance registration', async () => {
    const f = await fixture(), received: Record<string, unknown>[] = [], recalls: unknown[] = [];
    const bridge = client(f, { onMessage: value => received.push(value), onRecall: value => recalls.push(value) });
    await bridge.start();
    f.broadcast(message({ message_type: 'private' }));
    f.broadcast(message({ group_id: 'unselected' }));
    f.broadcast(message({ self_id: undefined }));
    f.broadcast(message());
    f.broadcast({ post_type: 'notice', notice_type: 'group_recall', self_id: account, group_id: group, message_id: 'm-1' });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await vi.waitFor(() => expect(recalls).toHaveLength(1));
    expect(bridge.rememberMessage(message({ group_id: 'unselected' }))).toBe(false);
    await expect(bridge.history('unselected')).rejects.toThrow('尚未授权');
    expect(f.actions.some(p => p.action.includes('send') || p.action.includes('mark') || p.action.includes('delete'))).toBe(false);
  });

  it('preserves numeric platform IDs without floating-point rounding', async () => {
    const f = await fixture(), received: Record<string, unknown>[] = [];
    const bridge = client(f, { onMessage: value => received.push(value) });
    await bridge.start();
    f.broadcast(`{"post_type":"message","message_type":"group","self_id":100001,"group_id":200001,"message_id":9007199254740993123,"user_id":9007199254740993124,"message":[]}`);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.message_id).toBe('9007199254740993123');
    expect(received[0]?.user_id).toBe('9007199254740993124');
  });

  it('immediately stops authorization on account changes and requires a fresh binding', async () => {
    const f = await fixture(), received: unknown[] = [];
    const bridge = client(f, { expectedAccountId: account, onMessage: value => received.push(value) });
    await bridge.start();
    f.broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 'different', status: { online: true } });
    f.broadcast(message({ self_id: 'different' }));
    await vi.waitFor(() => expect(bridge.status().state).toBe('account-mismatch'));
    expect(received).toEqual([]);
    await expect(bridge.history(group)).rejects.toThrow('尚未授权');
    expect(bridge.status().maskedAccount).toBe('******ent');
    expect(bridge.status().nickname).toBeNull();
  });

  it('updates health from an offline heartbeat and can reverify online state', async () => {
    const f = await fixture(), health: BridgeHealth[] = [], bridge = client(f, { onHealth: value => health.push(value) });
    await bridge.start();
    f.broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: account, status: { online: false } });
    await vi.waitFor(() => expect(bridge.status().online).toBe(false));
    f.broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: account, status: { online: true } });
    await vi.waitFor(() => expect(bridge.status().online).toBe(true));
    expect(health.map(value => value.state)).toContain('offline');
  });
  it('pauses collection when an online QQ account reports an unhealthy receive link', async () => {
    let good = false;
    const f = await fixture((packet, socket) => {
      if (packet.action !== 'get_status') return false;
      socket.send(JSON.stringify({ status: 'ok', echo: packet.echo, data: { online: true, good } })); return true;
    });
    const received: unknown[] = [], bridge = client(f, { onMessage: value => received.push(value) });
    expect(await bridge.start()).toMatchObject({ state: 'error', connected: true, online: false, accountId: account });
    expect(bridge.status().error).toContain('接收链路异常');
    good = true; f.broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: account, status: { online: true, good: true } });
    await vi.waitFor(() => expect(bridge.status().online).toBe(true));
    f.broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: account, status: { online: true, good: false } });
    f.broadcast(message());
    await vi.waitFor(() => expect(bridge.status().state).toBe('error'));
    expect(bridge.status().accountId).toBe(account); expect(received).toEqual([]);
  });

  it('normalizes selected-group histories but never claims completeness from an empty page', async () => {
    let page = 0;
    const f = await fixture((packet, socket) => {
      if (packet.action !== 'get_group_msg_history') return false;
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data: { messages: page++ === 0 ? [
        message({ message_id: 'new', message_seq: '20', time: 20 }), message({ message_id: 'old', message_seq: '10', time: 10 }),
        message({ message_id: 'foreign', group_id: 'unselected', time: 1 }), message({ message_id: 'private', message_type: 'private' }),
      ] : [] } })); return true;
    });
    const bridge = client(f); await bridge.start();
    expect(await bridge.history(group, null, 50)).toMatchObject({ messages: [{ message_id: 'new' }, { message_id: 'old' }], nextCursor: '10', complete: false });
    expect(await bridge.history(group, '10')).toEqual({ messages: [], nextCursor: null, complete: false });
    await expect(bridge.history(group, null, 101)).rejects.toThrow('分页参数');
    expect(f.actions.filter(value => value.action === 'get_group_msg_history')[1]?.params).toMatchObject({ group_id: group, message_seq: '10', count: 100 });
  });

  it('rejects history results when permission is revoked while the request is in flight', async () => {
    let selected = true, reply: (() => void) | undefined;
    const f = await fixture((packet, socket) => {
      if (packet.action !== 'get_group_msg_history') return false;
      reply = () => socket.send(JSON.stringify({ status: 'ok', echo: packet.echo, data: { messages: [message()] } })); return true;
    });
    const bridge = client(f, { isGroupSelected: () => selected }); await bridge.start();
    const history = bridge.history(group);
    const rejected = expect(history).rejects.toThrow('尚未授权');
    await vi.waitFor(() => expect(reply).toBeDefined());
    selected = false; reply!(); await rejected;
  });

  it('uses SnowLuma message-id pagination instead of NapCat sequence parameters', async () => {
    const f = await fixture((packet, socket) => {
      if (packet.action !== 'get_group_msg_history') return false;
      socket.send(JSON.stringify({ status: 'ok', echo: packet.echo, data: { messages: [message({ message_id: '-1234', message_seq: '7654' })] } })); return true;
    });
    const bridge = client(f, { flavor: 'snowluma' }); await bridge.start();
    expect((await bridge.history(group, '-2000')).nextCursor).toBe('-1234');
    expect(f.actions.find(p => p.action === 'get_group_msg_history')?.params).toEqual({ group_id: group, count: 100, reverse_order: true, message_id: '-2000' });
  });

  it('requires an observed parent relationship before fetching replies, forwards, images or files', async () => {
    const f = await fixture((packet, socket) => {
      const data = packet.action === 'get_msg' ? message({ message_id: 'reply-id' })
        : packet.action === 'get_forward_msg' ? { messages: [{ content: [{ type: 'text', data: { text: '合成转发' } }] }] }
        : packet.action === 'get_group_file_url' ? { url: 'https://example.invalid/synthetic.pdf' }
        : packet.action === 'get_image' ? { url: 'https://example.invalid/synthetic.png' } : null;
      if (!data) return false;
      socket.send(JSON.stringify({ status: 'ok', echo: packet.echo, data })); return true;
    });
    const bridge = client(f); await bridge.start();
    bridge.rememberMessage(message({ message: [
      { type: 'reply', data: { id: 'reply-id' } }, { type: 'forward', data: { id: 'forward-id' } },
      { type: 'file', data: { file_id: 'file-id', busid: 102 } }, { type: 'image', data: { file: 'image-id' } },
    ] }));
    for (const promise of [bridge.getReferencedMessage(group, 'm-1', 'unknown'), bridge.getForward(group, 'm-1', 'unknown'),
      bridge.getFileUrl(group, 'm-1', 'unknown'), bridge.getFileUrl(group, 'm-1', 'file-id', 999), bridge.getImage(group, 'm-1', 'unknown')]) await expect(promise).rejects.toThrow();
    expect(f.actions).toHaveLength(2);
    expect((await bridge.getReferencedMessage(group, 'm-1', 'reply-id')).message_id).toBe('reply-id');
    expect(await bridge.getForward(group, 'm-1', 'forward-id')).toHaveLength(1);
    expect((await bridge.getFileUrl(group, 'm-1', 'file-id')).url).toContain('synthetic.pdf');
    expect((await bridge.getImage(group, 'm-1', 'image-id')).url).toContain('synthetic.png');
    expect(f.actions.find(p => p.action === 'get_group_file_url')?.params).toEqual({ group_id: group, file_id: 'file-id', busid: 102 });
  });

  it('does not expose a reference resolved from a different group', async () => {
    const f = await fixture((packet, socket) => {
      if (packet.action !== 'get_msg') return false;
      socket.send(JSON.stringify({ status: 'ok', echo: packet.echo, data: message({ group_id: 'foreign' }) })); return true;
    });
    const bridge = client(f); await bridge.start();
    bridge.rememberMessage(message({ message: [{ type: 'reply', data: { id: 'reply-id' } }] }));
    await expect(bridge.getReferencedMessage(group, 'm-1', 'reply-id')).rejects.toThrow('不属于原群');
  });

  it('normalizes group uploads and refuses arbitrary local file paths for image lookups', async () => {
    const f = await fixture(), received: Record<string, unknown>[] = [], bridge = client(f, { onMessage: value => received.push(value) });
    await bridge.start();
    f.broadcast({ post_type: 'notice', notice_type: 'group_upload', group_id: group, self_id: account, time: 123, file: { id: 'f-1', name: '合成.docx', busid: 102 } });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ message_id: 'upload:f-1:123', message: [{ type: 'file', data: { file_id: 'f-1', name: '合成.docx' } }] });
    bridge.rememberMessage(message({ message: [{ type: 'image', data: { file: 'C:\\secret.txt' } }] }));
    await expect(bridge.getImage(group, 'm-1', 'C:\\secret.txt')).rejects.toThrow();
    expect(f.actions.some(p => p.action === 'get_image')).toBe(false);
  });

  it('correlates RPC echoes, times out unanswered reads and redacts error payloads', async () => {
    const f = await fixture((packet, socket) => {
      if (packet.action !== 'get_group_list') return false;
      socket.send(JSON.stringify({ status: 'ok', data: ['synthetic-secret'], echo: 'wrong-echo' })); return true;
    });
    const bridge = client(f, { requestTimeoutMs: 50 }); await bridge.start();
    await expect(bridge.getGroups()).rejects.toThrow('请求超时');
    expect(JSON.stringify(bridge.status())).not.toContain('synthetic-secret');
  });

  it('reconnects once after disconnect and rejects pending operations when stopped', async () => {
    const f = await fixture((packet) => packet.action === 'get_group_list');
    const bridge = client(f); await bridge.start();
    for (const socket of f.server.clients) socket.terminate();
    await vi.waitFor(() => expect(f.tokens).toHaveLength(2));
    await vi.waitFor(() => expect(bridge.status().online).toBe(true));
    const request = bridge.getGroups(), rejected = expect(request).rejects.toThrow('已停止');
    bridge.stop(); await rejected;
    expect(bridge.status()).toMatchObject({ state: 'stopped', connected: false, online: false });
  });

  it('closes oversized packets without emitting content', async () => {
    const f = await fixture(), received: unknown[] = [], bridge = client(f, { maxPayloadBytes: 1024, onMessage: value => received.push(value), reconnectMinMs: 1000 });
    await bridge.start();
    f.broadcast(message({ message: [{ type: 'text', data: { text: 'x'.repeat(2048) } }] }));
    await vi.waitFor(() => expect(bridge.status().online).toBe(false));
    expect(received).toEqual([]);
  });
});
