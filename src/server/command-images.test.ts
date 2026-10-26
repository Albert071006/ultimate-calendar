import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createRemoteService } from './service';
import { createRemoteHttpServer } from './http';
import type { ChatMessage } from '../ai/deepseek';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const image = { label: '合成截图.png', imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH0cAAAAASUVORK5CYII=' };
const otherImage = { label: '另一张合成图.png', imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC' };

async function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'planner-command-images-'));
  cleanup.push(async () => { rmSync(folder, { recursive: true, force: true }); });
  const payloads: Array<{ messages: ChatMessage[] }> = [];
  const service = createRemoteService({ dataDirectory: folder, backupDirectory: join(folder, 'backups'), getApiKey: async () => 'synthetic-test-key', controller: {
    getModelInputModalities: () => ['text', 'image'],
    fetch: async (url, init) => {
      expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'query', reply: '合成回答' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    },
  } });
  const http = createRemoteHttpServer({ service, origin: 'http://localhost:3210', secureCookie: false });
  const port = await http.listen(0);
  cleanup.push(async () => { await http.close(); await service.close(); });
  const call = (path: string, init: RequestInit): Promise<Response> => new Promise((done, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: init.method, headers: { Host: 'localhost:3210', ...init.headers as Record<string, string> } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on('error', reject); if (init.body) request.write(init.body); request.end();
  });
  const paired = await call('/api/v1/pair', { method: 'POST', headers: { Origin: 'http://localhost:3210', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: service.state.createPairingCode(), name: '合成图片测试设备' }) });
  expect(paired.status).toBe(200);
  const session = await paired.json();
  const headers = { Cookie: paired.headers.get('set-cookie')!.split(';')[0]!, Origin: 'http://localhost:3210', 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken };
  const rpc = (requestId: string, input: unknown, includeCsrf = true) => call('/api/v1/rpc/command', {
    method: 'POST', headers: includeCsrf ? headers : { Cookie: headers.Cookie, Origin: headers.Origin, 'Content-Type': headers['Content-Type'] },
    body: JSON.stringify({ requestId, identity: session.identity, input }),
  });
  return { rpc, payloads };
}

describe('assistant images over authenticated HTTP', () => {
  it('transmits original PNG pixels after pairing and CSRF, replays exact retries and rejects altered images', async () => {
    const { rpc, payloads } = await setup();
    const input = { operationId: 'image-business', text: '解释这张合成图片', image };
    expect((await rpc('image-wire', input, false)).status).toBe(403);
    expect(payloads).toHaveLength(0);
    const response = await rpc('image-wire', input); expect(response.status).toBe(200);
    const first = await response.json(); expect(first).toMatchObject({ ok: true, data: { reply: '合成回答' } });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.messages.at(-1)!.content).toContainEqual({ type: 'image_url', image_url: { url: image.imageDataUrl } });
    expect(await (await rpc('image-wire', input)).json()).toEqual(first);
    expect(await (await rpc('image-wire-second', input)).json()).toEqual(first);
    expect(payloads).toHaveLength(1);
    expect((await rpc('image-wire', { ...input, image: otherImage })).status).toBe(409);
    expect(await (await rpc('changed-image-wire', { ...input, image: otherImage })).json()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(payloads).toHaveLength(1);
  });

  it('rejects spoofed current and historical images before AI while preserving legacy text commands', async () => {
    const { rpc, payloads } = await setup();
    const fake = { label: 'spoof.png', imageDataUrl: 'data:image/png;base64,aGVsbG8=' };
    for (const [index, input] of [
      { operationId: 'bad-current', text: '查看图片', image: fake },
      { operationId: 'bad-history', text: '解释上一张', history: [{ role: 'user', text: '', image: fake }] },
    ].entries()) {
      const response = await rpc(`invalid-image-${index}`, input);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(payloads).toHaveLength(0);
    const response = await rpc('text-wire', { operationId: 'text-business', text: '明天有什么安排' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { reply: '合成回答' } });
    expect(payloads).toHaveLength(1);
    expect(typeof payloads[0]!.messages.at(-1)!.content).toBe('string');
    expect(JSON.parse(payloads[0]!.messages.at(-1)!.content as string)).toMatchObject({ userCommand: '明天有什么安排' });
  });
});
