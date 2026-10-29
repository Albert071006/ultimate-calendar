import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TokenUsageSchema, type ApiError, type Settings, type TokenUsage } from '../shared/contracts';
import type { PriceQuote } from '../shared/account';
import { estimateCost } from './costs';
import { LedgerError } from '../ledger/service';
import { reasoningRequest } from '../shared/ai-reasoning';

export class WorkflowError extends Error {
  constructor(readonly code: ApiError['code'], message: string, readonly retryable = false) { super(message); }
}
export function safeError(error: unknown): ApiError {
  return error instanceof LedgerError ? { code:error.code === 'DUPLICATE' ? 'CONFLICT' : error.code, message:error.message,retryable:false }
    : error instanceof WorkflowError ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: error instanceof z.ZodError ? 'VALIDATION' : 'INTERNAL', message: error instanceof z.ZodError ? `输入无效：${error.issues[0]?.message ?? ''}` : '操作未完成，请重试或检查本地数据', retryable: false };
}
const UsageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative(), prompt_cache_hit_tokens: z.number().int().nonnegative().default(0) }).refine(u => u.prompt_cache_hit_tokens <= u.prompt_tokens && u.total_tokens >= u.prompt_tokens + u.completion_tokens);
const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().max(500_000).nullable(), refusal: z.string().max(500_000).nullable().optional() }), finish_reason: z.string().max(100).nullable() })).length(1), usage: UsageSchema });
const responseFailures = {
  AI_BODY_JSON: 'DeepSeek 的响应体不是完整 JSON',
  AI_ENVELOPE: 'DeepSeek 的响应结构或用量信息不符合接口约定',
  AI_EMPTY: 'DeepSeek 没有返回可用的回答内容',
  AI_TRUNCATED: 'DeepSeek 的回答达到输出上限，内容被截断',
  AI_REFUSED: 'DeepSeek 拒绝处理本次请求',
  AI_UNFINISHED: 'DeepSeek 没有正常完成本次回答',
  AI_CONTENT_JSON: 'DeepSeek 的回答内容不是有效 JSON',
  AI_SCHEMA: 'DeepSeek 已返回 JSON，但字段或取值不符合处理约定',
} as const;
// Schema issue messages, union inputs and arbitrary object keys can contain private content.
// Only fixed codes/field names are diagnostic output; never serialize a Zod issue or model value.
const diagnosticIssueCodes = new Set(['invalid_type', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of', 'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom']);
const diagnosticFields = new Set(['choices', 'message', 'content', 'refusal', 'finish_reason', 'usage', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens',
  'kind', 'reply', 'questions', 'query', 'detail', 'mutations', 'changes', 'type', 'key', 'values', 'patch', 'id', 'expectedVersion', 'confirmDuplicate', 'note', 'title', 'category',
  'date', 'month', 'occurredAt', 'dateNote', 'amountCents', 'personalCents', 'incomeCents', 'assetSaleCents', 'cashflows', 'accountId', 'deltaCents', 'balanceCents', 'asOf', 'timing',
  'adjustments', 'targetEntryIds', 'relatedEntryIds', 'snapshotPositions', 'snapshotId', 'position', 'fromDate', 'toDate', 'transactionId', 'candidates', 'sourceIds', 'sourceQuote', 'rows', 'uncertainties']);
function responseFailure(code: keyof typeof responseFailures, error?: unknown): WorkflowError {
  const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
  const issueCode = issue && diagnosticIssueCodes.has(issue.code) ? `/${issue.code}` : '';
  const path = issue?.path.slice(0, 8).map(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 && part <= 500
    ? String(part) : typeof part === 'string' && diagnosticFields.has(part) ? part : '字段').join('.');
  return new WorkflowError('AI_RESPONSE', `${responseFailures[code]}；本次结果未采用。诊断：${code}${issueCode}${path ? `（${path}）` : ''}`);
}
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] };
export async function completeJson<T>(options: { key: string | null; settings: Settings; messages: ChatMessage[]; schema: z.ZodType<T>; operationId: string; purpose: TokenUsage['purpose']; now: string; autoQuote?: PriceQuote | null; fetch?: typeof fetch; timeoutMs?: number; maxAttempts?: number; sleep?(ms: number): Promise<void>; onUsage?(usage: TokenUsage): void; onParsedResponse?(value: unknown): void }): Promise<{ value: T; usage: TokenUsage }> {
  if (!options.key) throw new WorkflowError('NO_API_KEY', '请先在设置中配置 DeepSeek API 密钥');
  const { timeoutMs, ...reasoning } = reasoningRequest(options.settings);
  const body = JSON.stringify({ model: options.settings.model, messages: options.messages, response_format: { type: 'json_object' }, ...reasoning, stream: false });
  // A lost thinking response may already have been billed. Never resend it automatically.
  const attempts = reasoning.thinking.type === 'enabled' ? 1 : Math.max(1, Math.min(3, options.maxAttempts ?? 3));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(250 * 2 ** (attempt - 1));
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? timeoutMs);
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
      let raw: unknown; try { raw = JSON.parse(responseText); } catch { throw responseFailure('AI_BODY_JSON'); }
      const usageResult = UsageSchema.safeParse(raw && typeof raw === 'object' && 'usage' in raw ? raw.usage : null);
      let usage: TokenUsage | null = null;
      if (usageResult.success) {
        const u = usageResult.data;
        const cost = estimateCost(options.settings, { input: u.prompt_tokens, cached: u.prompt_cache_hit_tokens, output: u.completion_tokens }, options.autoQuote);
        usage = TokenUsageSchema.parse({ id: randomUUID(), operationId: options.operationId, createdAt: options.now, purpose: options.purpose, model: options.settings.model, inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, cachedInputTokens: u.prompt_cache_hit_tokens, totalTokens: u.total_tokens, ...cost });
      }
      let content: unknown;
      try {
        const parsed = envelope.safeParse(raw);
        if (!parsed.success) throw responseFailure('AI_ENVELOPE', parsed.error);
        const choice = parsed.data.choices[0]!;
        if (choice.finish_reason === 'content_filter' || choice.message.refusal?.trim()) throw responseFailure('AI_REFUSED');
        if (choice.finish_reason === 'length') throw responseFailure('AI_TRUNCATED');
        if (choice.finish_reason !== 'stop') throw responseFailure('AI_UNFINISHED');
        if (!choice.message.content?.trim()) throw responseFailure('AI_EMPTY');
        try { content = JSON.parse(choice.message.content); } catch { throw responseFailure('AI_CONTENT_JSON'); }
      }
      catch (error) {
        if (usage) options.onUsage?.(usage);
        throw error;
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
      catch (error) { throw responseFailure('AI_SCHEMA', error); }
    } finally { clearTimeout(timer); }
  }
  throw new WorkflowError('NETWORK', 'DeepSeek 请求失败', true);
}
