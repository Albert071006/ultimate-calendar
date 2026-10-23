import { requests, responses, methods, type Method } from './protocol';
import { imageDataUrlValid } from './files';
import { safeError } from '../ai/deepseek';
import type { ApiError, ApiResult } from '../shared/contracts';
export interface Caller { senderId: number; frameId: number; url: string }
export function trustedCaller(actual: Caller | null, expected: Caller | null): boolean {
  return !!actual && !!expected && actual.senderId === expected.senderId && actual.frameId === expected.frameId && actual.url === expected.url;
}
type Handlers = Partial<Record<Method, (input: any) => Promise<unknown>>>;
const failure = (code: ApiError['code'], message: string): ApiResult<never> => ({ ok: false, error: { code, message, retryable: false } });
export async function dispatchRequest(method: string, input: unknown, actual: Caller | null, expected: Caller | null, handlers: Handlers): Promise<ApiResult<unknown>> {
  if (!trustedCaller(actual, expected)) return failure('VALIDATION', '此页面无权访问本机日历');
  if (!methods.includes(method as Method)) return failure('VALIDATION', '不支持的操作');
  const name = method as Method; const parsed = requests[name].safeParse(input);
  if (!parsed.success) return failure('VALIDATION', '输入格式无效，请检查后重试');
  const body = parsed.data;
  const image = body && typeof body === 'object' ? ('imageDataUrl' in body ? body.imageDataUrl : 'source' in body ? body.source.imageDataUrl : null) : null;
  if (typeof image === 'string' && !imageDataUrlValid(image)) return failure('VALIDATION', '图片内容与 PNG/JPEG 类型不符');
  try {
    const handler = handlers[name]; if (!handler) return failure('INTERNAL', '本机服务尚未准备好，请重新打开应用');
    const result = await handler(body); const checked = responses[name].safeParse(result);
    return checked.success ? checked.data : failure('INTERNAL', '本机服务返回无效数据，请重新打开应用');
  } catch (error) { return { ok: false, error: safeError(error) }; }
}
