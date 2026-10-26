import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TokenUsageSchema, type ApiError, type Settings, type TokenUsage } from '../shared/contracts';
import type { PriceQuote } from '../shared/account';
import { estimateCost } from './costs';
import { LedgerError } from '../ledger/service';

export class WorkflowError extends Error {
  constructor(readonly code: ApiError['code'], message: string, readonly retryable = false) { super(message); }
}
export function safeError(error: unknown): ApiError {
  return error instanceof LedgerError ? { code:error.code === 'DUPLICATE' ? 'CONFLICT' : error.code, message:error.message,retryable:false }
    : error instanceof WorkflowError ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: error instanceof z.ZodError ? 'VALIDATION' : 'INTERNAL', message: error instanceof z.ZodError ? `输入无效：${error.issues[0]?.message ?? ''}` : '操作未完成，请重试或检查本地数据', retryable: false };
}
const UsageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative(), prompt_cache_hit_tokens: z.number().int().nonnegative().default(0) }).refine(u => u.prompt_cache_hit_tokens <= u.prompt_tokens && u.total_tokens >= u.prompt_tokens + u.completion_tokens);
const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1).max(500_000) }), finish_reason: z.literal('stop') })).length(1), usage: UsageSchema });
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] };
export async function completeJson<T>(options: { key: string | null; settings: Settings; messages: ChatMessage[]; schema: z.ZodType<T>; operationId: string; purpose: TokenUsage['purpose']; now: string; autoQuote?: PriceQuote | null; fetch?: typeof fetch; timeoutMs?: number; maxAttempts?: number; sleep?(ms: number): Promise<void>; onUsage?(usage: TokenUsage): void; onParsedResponse?(value: unknown): void }): Promise<{ value: T; usage: TokenUsage }> {
  if (!options.key) throw new WorkflowError('NO_API_KEY', '请先在设置中配置 DeepSeek API 密钥');
  const body = JSON.stringify({ model: options.settings.model, messages: options.messages, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 8192, stream: false });
  const attempts = Math.max(1, Math.min(3, options.maxAttempts ?? 3));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(250 * 2 ** (attempt - 1));
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 45_000);
    try {
      let response: Response;
      try { response = await (options.fetch ?? fetch)('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.key}` }, body, signal: abort.signal }); }
      catch { if (attempt + 1 < attempts) continue; throw new WorkflowError('NETWORK', 'DeepSeek 网络连接或请求超时，请重试', true); }
      if (!response.ok) {
        if ([429, 500, 503].includes(response.status) && attempt + 1 < attempts) continue;
        if (response.status === 401) throw new WorkflowError('AUTH', 'DeepSeek 密钥无效，请检查设置');
        if (response.status === 402) throw new WorkflowError('BALANCE', 'DeepSeek 余额不足，请检查账户');
        if (response.status === 429) throw new WorkflowError('RATE_LIMIT', 'DeepSeek 请求频率受限，请稍后重试', true);
        throw new WorkflowError('NETWORK', `DeepSeek 请求失败（HTTP ${response.status}）`, [500, 503].includes(response.status));
      }
      let responseText: string;
      try { responseText = await response.text(); }
      catch { if (attempt + 1 < attempts) continue; throw new WorkflowError('NETWORK', 'DeepSeek 响应传输中断，请重试', true); }
      let raw: unknown; try { raw = JSON.parse(responseText); } catch { throw new WorkflowError('AI_RESPONSE', 'DeepSeek 返回的响应不是完整 JSON，请重试'); }
      const usageResult = UsageSchema.safeParse(raw && typeof raw === 'object' && 'usage' in raw ? raw.usage : null);
      let usage: TokenUsage | null = null;
      if (usageResult.success) {
        const u = usageResult.data;
        const cost = estimateCost(options.settings, { input: u.prompt_tokens, cached: u.prompt_cache_hit_tokens, output: u.completion_tokens }, options.autoQuote);
        usage = TokenUsageSchema.parse({ id: randomUUID(), operationId: options.operationId, createdAt: options.now, purpose: options.purpose, model: options.settings.model, inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, cachedInputTokens: u.prompt_cache_hit_tokens, totalTokens: u.total_tokens, ...cost });
      }
      let content: unknown;
      try { const parsed = envelope.parse(raw); content = JSON.parse(parsed.choices[0]!.message.content); }
      catch {
        if (usage) options.onUsage?.(usage);
        throw new WorkflowError('AI_RESPONSE', 'DeepSeek 返回空白、截断或不符合约定的 JSON，请重试或人工校对');
      }
      // Capture can durably retain paid JSON before validating its references. A storage failure
      // in usage accounting/backup must not prevent that checkpoint from being saved first.
      try { options.onParsedResponse?.(content); }
      catch (error) {
        // Still record known billable usage when possible, without masking the original failure.
        try { if (usage) options.onUsage?.(usage); } catch { /* Preserve the response-storage error. */ }
        throw error;
      }
      if (usage) options.onUsage?.(usage);
      try { return { value: options.schema.parse(content), usage: usage! }; }
      catch { throw new WorkflowError('AI_RESPONSE', 'DeepSeek 返回空白、截断或不符合约定的 JSON，请重试或人工校对'); }
    } finally { clearTimeout(timer); }
  }
  throw new WorkflowError('NETWORK', 'DeepSeek 请求失败', true);
}
