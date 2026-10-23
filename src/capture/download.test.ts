import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { WebSocketServer } from 'ws';
import { createReadOnlyBridge, type BridgeAttachmentLocation, type ReadOnlyBridge } from './bridge';
import { downloadAttachment, isPublicAttachmentAddress, validateAttachmentUrl, AttachmentDownloadError } from './download';

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:https', () => ({ request: network.request }));
const clients: ReadOnlyBridge[] = [], servers: WebSocketServer[] = [];
type Reply = { code?: number; headers?: Record<string, string>; chunks?: Buffer[]; error?: Error };
let replies: Reply[];
beforeEach(() => {
  replies = [];
  network.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  network.request.mockReset().mockImplementation((_url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const result = new EventEmitter() as EventEmitter & { end: () => void };
    result.end = () => queueMicrotask(() => {
      const reply = replies.shift() ?? { chunks: [Buffer.from('synthetic file')] };
      if (reply.error) { result.emit('error', reply.error); return; }
      const response = Readable.from(reply.chunks ?? []) as unknown as IncomingMessage;
      response.statusCode = reply.code ?? 200;
      response.headers = reply.headers ?? {};
      callback(response);
    });
    return result;
  });
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  for (const server of servers.splice(0)) { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

/** Locator authorization is exercised over a real synthetic OneBot socket, not bypassed in tests. */
async function locator(data: Record<string, unknown>): Promise<BridgeAttachmentLocation> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server);
  server.on('connection', socket => socket.on('message', value => {
    const packet = JSON.parse(value.toString()) as { action: string; echo: string };
    const response = packet.action === 'get_status' ? { online: true } : packet.action === 'get_login_info' ? { user_id: '123' } : data;
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data: response }));
  }));
  await once(server, 'listening');
  const client = createReadOnlyBridge({ endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'synthetic', isGroupSelected: (_a, g) => g === '456' });
  clients.push(client); await client.start();
  client.rememberMessage({ self_id: '123', group_id: '456', message_id: '789', message: [{ type: 'image', data: { file: 'image-1' } }] });
  return client.getImage('456', '789', 'image-1');
}

describe('QQ attachment download boundary', () => {
  it('only accepts original frozen locators produced by an authorized bridge query', async () => {
    const value = await locator({ url: 'https://gchat.qpic.cn/synthetic.png' });
    expect(Object.isFrozen(value)).toBe(true);
    await expect(downloadAttachment({ ...value }, { fileName: '合成.png' })).rejects.toThrow('必须来自');
    await expect(downloadAttachment({ url: value.url } as BridgeAttachmentLocation, { fileName: '合成.png' })).rejects.toThrow('必须来自');
    expect(network.request).not.toHaveBeenCalled();
    expect((await downloadAttachment(value, { fileName: '合成.png' })).toString()).toBe('synthetic file');
  });

  it('enforces known QQ resource hosts, HTTPS and no arbitrary file or network targets', () => {
    for (const url of ['file:///C:/secret', 'http://127.0.0.1/file', 'https://127.0.0.1', 'https://qq.com.attacker.invalid/file', 'https://attacker.ftn.qq.com.evil/', 'https://gchat.qpic.cn:123/file', 'https://token@gchat.qpic.cn/file', 'http://grouptalk.c2c.qq.com/file']) expect(() => validateAttachmentUrl(url)).toThrow();
    expect(validateAttachmentUrl('http://gchat.qpic.cn/synthetic.png').protocol).toBe('https:');
    expect(validateAttachmentUrl('https://synthetic.ftn.qq.com/file').hostname).toBe('synthetic.ftn.qq.com');
  });

  it('rejects private, link-local, documentation, multicast and mapped-IP DNS answers', () => {
    for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.1.1', '192.168.1.1', '192.0.2.1', '198.19.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::']) expect(isPublicAttachmentAddress(address), address).toBe(false);
    expect(isPublicAttachmentAddress('93.184.216.34')).toBe(true);
    expect(isPublicAttachmentAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('pins DNS for the request and refuses a host if any answer reaches a private address', async () => {
    const value = await locator({ url: 'https://gchat.qpic.cn/synthetic.png' });
    await downloadAttachment(value, { fileName: '合成.png' });
    const options = network.request.mock.calls[0]![1] as RequestOptions;
    const callback = vi.fn();
    options.lookup!('gchat.qpic.cn', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    network.request.mockClear();
    network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(downloadAttachment(value, { fileName: '合成.png' })).rejects.toThrow('非公开网络');
    expect(network.request).not.toHaveBeenCalled();
  });

  it('validates every redirect and never follows a downgrade or arbitrary domain', async () => {
    const value = await locator({ url: 'https://gchat.qpic.cn/start' });
    replies.push({ code: 302, headers: { location: 'https://gzc.qpic.cn/final' } }, { chunks: [Buffer.from('ok')] });
    expect((await downloadAttachment(value, { fileName: '合成.png' })).toString()).toBe('ok');
    expect(network.lookup).toHaveBeenNthCalledWith(2, 'gzc.qpic.cn', { all: true, verbatim: true });
    for (const target of ['http://gchat.qpic.cn/final', 'https://attacker.invalid/file']) {
      replies.push({ code: 302, headers: { location: target } });
      await expect(downloadAttachment(value, { fileName: '合成.png' })).rejects.toThrow();
    }
  });

  it('enforces declared and streaming byte limits, including chunked replies', async () => {
    const value = await locator({ url: 'https://gchat.qpic.cn/file' });
    replies.push({ headers: { 'content-length': '6' }, chunks: [Buffer.from('abcdef')] });
    await expect(downloadAttachment(value, { fileName: '合成.png', maxBytes: 5 })).rejects.toMatchObject({ status: 'too-large', message: '附件超过自动下载的大小上限' });
    replies.push({ chunks: [Buffer.from('abc'), Buffer.from('def')] });
    await expect(downloadAttachment(value, { fileName: '合成.png', maxBytes: 5 })).rejects.toThrow('大小上限');
  });

  it('rejects archives, local paths, unsupported extensions and oversized configured limits', async () => {
    const local = await locator({ file: 'C:\\Software\\OtherApplication\\runtime\\data\\secret.json' });
    await expect(downloadAttachment(local, { fileName: '合成.txt' })).rejects.toThrow('本机文件路径');
    const remote = await locator({ url: 'https://gchat.qpic.cn/file' });
    await expect(downloadAttachment(remote, { fileName: '合成.zip' })).rejects.toThrow('格式');
    await expect(downloadAttachment(remote, { fileName: '合成.png', maxBytes: 26 * 1024 * 1024 })).rejects.toThrow('限额');
    expect(network.request).not.toHaveBeenCalled();
  });

  it('reports expired URLs, empty files and HTML errors without exposing signed URLs', async () => {
    const value = await locator({ url: 'https://gchat.qpic.cn/file?rkey=synthetic-secret' });
    replies.push({ code: 403 });
    await expect(downloadAttachment(value, { fileName: '合成.png' })).rejects.toThrow('已过期');
    replies.push({ chunks: [] });
    await expect(downloadAttachment(value, { fileName: '合成.png' })).rejects.toThrow('为空');
    replies.push({ headers: { 'content-type': 'text/html' } });
    await expect(downloadAttachment(value, { fileName: '合成.png' })).rejects.toThrow('网页');
    replies.push({ error: new Error('QQ injected network error with synthetic-secret') });
    await expect(downloadAttachment(value, { fileName: '合成.png' })).rejects.toThrow('QQ 附件下载失败，请检查连接后重试');
    replies.push({ code: 403 });
    await expect(downloadAttachment(value, { fileName: '合成.png' })).rejects.toBeInstanceOf(AttachmentDownloadError);
  });

  it('bounds DNS lookup by the same overall deadline and handles caller cancellation', async () => {
    const value = await locator({ url: 'https://gchat.qpic.cn/file' });
    network.lookup.mockImplementation(() => new Promise(() => {}));
    await expect(downloadAttachment(value, { fileName: '合成.png', timeoutMs: 10 })).rejects.toThrow('取消或超时');
    const controller = new AbortController(); controller.abort();
    await expect(downloadAttachment(value, { fileName: '合成.png', signal: controller.signal })).rejects.toThrow('取消或超时');
    expect(network.request).not.toHaveBeenCalled();
  });
});
