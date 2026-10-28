import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { completeJson, WorkflowError } from './deepseek';
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
  it.each([
    { name: 'blank content', choice: { message: { content: ' \n\t' }, finish_reason: 'stop' }, code: 'AI_EMPTY' },
    { name: 'null content', choice: { message: { content: null }, finish_reason: 'stop' }, code: 'AI_EMPTY' },
    { name: 'truncated content', choice: { message: { content: '{"ok":true}' }, finish_reason: 'length' }, code: 'AI_TRUNCATED' },
    { name: 'filtered response', choice: { message: { content: null }, finish_reason: 'content_filter' }, code: 'AI_REFUSED' },
    { name: 'explicit refusal', choice: { message: { content: null, refusal: 'private refusal contents' }, finish_reason: 'stop' }, code: 'AI_REFUSED' },
    { name: 'unexpected finish reason', choice: { message: { content: '{"ok":true}' }, finish_reason: 'private finish reason' }, code: 'AI_UNFINISHED' },
    { name: 'malformed content JSON', choice: { message: { content: '{private invalid model contents' }, finish_reason: 'stop' }, code: 'AI_CONTENT_JSON' },
    { name: 'malformed envelope', choice: { message: { content: { private: 'private response contents' } }, finish_reason: 'stop' }, code: 'AI_ENVELOPE' },
  ])('classifies $name without exposing data, checkpointing incomplete output or retrying a paid response', async ({ choice, code }) => {
    let calls = 0; const usage: number[] = [], saved: unknown[] = [];
    let error: unknown;
    try {
      await completeJson({ ...base, onUsage: item => { usage.push(item.totalTokens); }, onParsedResponse: value => { saved.push(value); },
        fetch: async () => { calls++; return new Response(JSON.stringify({ choices: [choice], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); } });
    } catch (cause) { error = cause; }
    expect(error).toMatchObject({ code: 'AI_RESPONSE', retryable: false, message: expect.stringContaining(code) });
    expect(String(error)).not.toMatch(/private|synthetic-key/);
    expect(calls).toBe(1); expect(usage).toEqual([15]); expect(saved).toEqual([]);
  });
  it('separates invalid response JSON and invalid usage without inventing usage or retrying', async () => {
    for (const [body, code] of [
      ['private non-JSON response contents', 'AI_BODY_JSON'],
      [JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 'private account value' } }), 'AI_ENVELOPE'],
    ] as const) {
      let calls = 0; const usage: unknown[] = [];
      await expect(completeJson({ ...base, onUsage: value => { usage.push(value); }, fetch: async () => { calls++; return new Response(body); } }))
        .rejects.toMatchObject({ code: 'AI_RESPONSE', message: expect.stringContaining(code) });
      expect(calls).toBe(1); expect(usage).toEqual([]);
    }
  });
  it('reports schema issue codes and fixed field paths but never dynamic keys, values or validation messages', async () => {
    const privateValue = 'private-secret-value', privateKey = 'private-person@example.invalid';
    const cases = [
      { schema: z.object({ changes: z.array(z.object({ values: z.object({ amountCents: z.number().int() }) })) }), value: { changes: [{ values: { amountCents: privateValue } }] }, path: 'changes.0.values.amountCents' },
      { schema: z.record(z.string(), z.number()), value: { [privateKey]: privateValue }, path: '字段' },
      { schema: z.strictObject({ ok: z.boolean() }), value: { ok: true, [privateKey]: privateValue }, path: 'unrecognized_keys' },
      { schema: z.unknown().refine(() => false, { message: privateValue, path: [privateKey] }), value: privateValue, path: 'custom' },
    ];
    for (const item of cases) {
      let calls = 0; const usage: number[] = [], order: string[] = []; let error: unknown;
      try {
        await completeJson({ ...base, schema: item.schema, onParsedResponse: () => { order.push('parsed'); }, onUsage: value => { order.push('usage'); usage.push(value.totalTokens); },
          fetch: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(item.value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); } });
      } catch (cause) { error = cause; }
      expect(error).toMatchObject({ code: 'AI_RESPONSE', message: expect.stringContaining('AI_SCHEMA') });
      expect(String(error)).toContain(item.path); expect(String(error)).not.toMatch(/private|example\.invalid|synthetic-key/);
      expect(calls).toBe(1); expect(usage).toEqual([15]); expect(order).toEqual(['parsed', 'usage']);
    }
  });
  it('delivers parsed paid content before schema rejection without retrying', async () => {
    const saved: unknown[] = []; let calls = 0;
    await expect(completeJson({ ...base, schema: z.strictObject({ required: z.string() }),
      onParsedResponse: value => { saved.push(value); }, fetch: async () => { calls++; return success(); },
    })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(saved).toEqual([{ ok: true }]); expect(calls).toBe(1);
  });
  it('preserves a durable-response storage error without schema wrapping or a second charge', async () => {
    const failure = new WorkflowError('STORAGE', 'synthetic response persistence failed'); let calls = 0;
    await expect(completeJson({ ...base, onParsedResponse: () => { throw failure; },
      fetch: async () => { calls++; return success(); },
    })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
  it('persists parsed content before usage accounting or its backup can fail', async () => {
    const saved: unknown[] = []; const failure = new WorkflowError('STORAGE', 'synthetic usage backup failed'); let calls = 0;
    await expect(completeJson({ ...base, onParsedResponse: value => { saved.push(value); },
      onUsage: () => { expect(saved).toEqual([{ ok: true }]); throw failure; },
      fetch: async () => { calls++; return success(); },
    })).rejects.toBe(failure);
    expect(saved).toEqual([{ ok: true }]); expect(calls).toBe(1);
  });
  it('aborts timed-out fetches and still stops after the third network attempt', async () => {
    let calls = 0; await expect(completeJson({ ...base, timeoutMs: 2, sleep: async () => {}, fetch: async (_url, init) => { calls++; return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('abort')))); } })).rejects.toMatchObject({ code: 'NETWORK' }); expect(calls).toBe(3);
  });
});
