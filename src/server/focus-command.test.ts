import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { apiResultSchema, CommandResultSchema, type CommandRequest, type FocusCommand } from '../shared/contracts';
import { createRemoteService } from './service';

it('preserves timer actions and grounded writes across RPC retries and service restarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-focus-'));
  let proposal: FocusCommand = { type: 'start', mode: 'stopwatch', title: '练习' };
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ kind: 'focus', command: proposal }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  })));
  const options = {
    dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), startupBackup: false, scheduleMonthlyAllowance: false,
    getApiKey: async () => 'synthetic', controller: { fetch, now: () => '2030-05-15T18:00:00+08:00' },
  };
  let service = createRemoteService(options);
  async function command(requestId: string, input: CommandRequest) {
    const raw = await service.rpc('command', { requestId, identity: service.state.identity(), input }, 'synthetic-device');
    const result = apiResultSchema(CommandResultSchema).parse(raw);
    if (!result.ok) throw Error(result.error.message);
    return result.data;
  }
  try {
    const initialJournal = service.snapshot().journal;
    const start = { operationId: 'start-timer', text: '开始练习正向计时', focusTimer: null };
    const started = await command('wire-start', start);
    expect(started.focusAction).toEqual({ type: 'start', mode: 'stopwatch', title: '练习' });
    expect(service.snapshot().journal).toEqual(initialJournal);
    expect(service.snapshot().focusSessions).toHaveLength(0);
    const legacy = await command('wire-legacy', { operationId: 'old-client', text: '开始练习正向计时' });
    expect(legacy.focusAction).toBeUndefined();
    expect(legacy.conversationState?.domain).toBe('calendar');

    proposal = { type: 'create', title: '练习' };
    const create = { operationId: 'record', text: '补记刚才练习40分钟', focusTimer: null };
    const saved = await command('wire-create', create);
    expect(saved.mutationResult?.status).toBe('applied');
    expect(service.snapshot().focusSessions).toMatchObject([{ title: '练习', durationSeconds: 2400 }]);

    await service.close();
    service = createRemoteService(options);
    expect(await command('retry-start', start)).toEqual(started);
    expect(await command('retry-create', create)).toEqual(saved);
    expect(service.snapshot().focusSessions).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
