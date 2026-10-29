import { z } from 'zod';

export const ReasoningEffortSchema = z.enum(['none', 'low', 'high', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export const AI_SETTINGS_HEADER = 'X-Planner-AI-Settings-Version';
export const AI_SETTINGS_VERSION = '1';
// A ledger command has at most two serial model calls (240 s each), plus transport margin.
export const AI_RPC_TIMEOUT_MS = 510_000;
export const isAiRpcPath = (path: string) => /^\/api\/v1\/rpc\/(command|analyzeSource|importCourses)$/.test(path);
export const reasoningOptions = [
  { value: 'none', label: '关闭思考 · 更快' },
  { value: 'low', label: '低 · 简单整理' },
  { value: 'high', label: '高 · 复杂理解' },
  { value: 'max', label: '最高 · 更充分思考' },
] as const;
// Only offer documented native effort levels; a model-list entry alone does not
// establish support. Unknown/manual models keep the pre-existing request mode.
export const supportsReasoningEffort = (model: string) => ['deepseek-flash', 'deepseek-v4-pro'].includes(model);
export function reasoningRequest(settings: { model: string; reasoningEffort?: ReasoningEffort }) {
  const effort = supportsReasoningEffort(settings.model) ? settings.reasoningEffort ?? 'none' : 'none';
  return { thinking: { type: effort === 'none' ? 'disabled' as const : 'enabled' as const },
    ...(effort === 'none' ? {} : { reasoning_effort: effort }),
    max_tokens: { none: 8192, low: 16384, high: 32768, max: 65536 }[effort],
    timeoutMs: { none: 45_000, low: 120_000, high: 180_000, max: 240_000 }[effort],
  };
}

/** Old clients use a strict Settings schema. Omit only the added field on the
 * wire, including a settings write receipt; never rewrite the durable receipt. */
export function legacyAiSettingsResult(method: string, result: unknown): unknown {
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('data' in result)) return result;
  const data = result.data;
  if (!data || typeof data !== 'object') return result;
  const omit = (value: object) => { const { reasoningEffort: _effort, ...rest } = value as Record<string, unknown>; return rest; };
  if (method === 'saveSettings') return { ...result, data: omit(data) };
  if (method === 'snapshot' && 'settings' in data && data.settings && typeof data.settings === 'object') return { ...result, data: { ...data, settings: omit(data.settings) } };
  return result;
}
