import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { completeJson } from './deepseek';
import { DEFAULT_SETTINGS } from '../shared/contracts';
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const base = { key: 'synthetic-key', settings: DEFAULT_SETTINGS, messages: [{ role: 'user' as const, content: 'JSON' }], schema: z.strictObject({ ok: z.boolean() }), operationId: 'test', purpose: 'command' as const, now: '2026-10-22T20:00:00+08:00' };
describe('real DeepSeek HTTP boundary', () => {
  it('backs off twice and retries network/503 with identical body, at most three attempts', async () => {
    const bodies: string[] = [], sleeps: number[] = []; let calls = 0;
    const result = await completeJson({ ...base, sleep: async ms => { sleeps.push(ms); }, fetch: async (url, init) => { expect(url).toBe('https://api.deepseek.com/chat/completions'); bodies.push(String(init?.body)); calls++; if (calls === 1) throw Error('network secret'); if (calls === 2) return new Response('private server details', { status: 503 }); return success(); } });
    expect(result.value).toEqual({ ok: true }); expect(calls).toBe(3); expect(new Set(bodies).size).toBe(1); expect(sleeps).toEqual([250, 500]);
  });
  it('retries interrupted response-body reads but does not retry completed malformed JSON', async () => {
    let calls = 0;
    const result = await completeJson({ ...base, sleep: async () => {}, fetch: async () => { calls++; return calls === 1 ? new Response(new ReadableStream({ start(c) { c.error(Error('connection reset')); } })) : success(); } });
    expect(result.value).toEqual({ ok: true }); expect(calls).toBe(2);
    calls = 0; await expect(completeJson({ ...base, sleep: async () => {}, fetch: async () => { calls++; return new Response('{'); } })).rejects.toMatchObject({ code: 'AI_RESPONSE' }); expect(calls).toBe(1);
  });
  it.each([400, 401, 402, 422])('never retries HTTP %i or exposes the upstream body/key', async status => {
    let calls = 0; let error: unknown; try { await completeJson({ ...base, sleep: async () => {}, fetch: async () => { calls++; return new Response('synthetic-key private server body', { status }); } }); } catch (e) { error = e; }
    expect(calls).toBe(1); expect(String(error)).not.toContain('synthetic-key'); expect(String(error)).not.toContain('private server body');
  });
  it.each([429, 500, 503])('stops after three attempts for transient HTTP %i', async status => {
    let calls = 0; await expect(completeJson({ ...base, sleep: async () => {}, fetch: async () => { calls++; return new Response('', { status }); } })).rejects.toMatchObject({ retryable: true }); expect(calls).toBe(3);
  });
  it.each(['', '{', '{"ok":"wrong"}'])('rejects empty/truncated/schema-invalid model content without retry', async content => {
    let calls = 0; const usage: number[] = [];
    await expect(completeJson({ ...base, onUsage: u => { usage.push(u.totalTokens); }, fetch: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(calls).toBe(1); expect(usage).toEqual([15]);
  });
  it('rejects truncated finish reason even when JSON happens to parse and records known billable usage', async () => {
    const usage: number[] = []; await expect(completeJson({ ...base, onUsage: u => { usage.push(u.totalTokens); }, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })) })).rejects.toMatchObject({ code: 'AI_RESPONSE' }); expect(usage).toEqual([15]);
  });
  it('aborts timed-out fetches and still stops after the third network attempt', async () => {
    let calls = 0; await expect(completeJson({ ...base, timeoutMs: 2, sleep: async () => {}, fetch: async (_url, init) => { calls++; return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('abort')))); } })).rejects.toMatchObject({ code: 'NETWORK' }); expect(calls).toBe(3);
  });
});
