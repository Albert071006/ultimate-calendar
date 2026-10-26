import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const displayName = z.string().trim().min(1).max(240)
  .refine(value => !/(?:[A-Za-z]:[\\/]|\\\\|file:\/\/)/i.test(value), '资料名称不能包含本地绝对路径');
export const ResourceUrlSchema = z.string().trim().max(4000).refine(value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}, '请输入 http 或 https 网页地址，不支持程序、脚本或带密码的地址');

/** Shared metadata only. Absolute paths belong to the owning computer's private registry. */
export const ResourceReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: identifier, name: displayName, kind: z.literal('file'), deviceId: identifier, deviceName: displayName }),
  z.strictObject({ id: identifier, name: displayName, kind: z.literal('folder'), deviceId: identifier, deviceName: displayName }),
  z.strictObject({ id: identifier, name: displayName, kind: z.literal('web'), url: ResourceUrlSchema }),
]);
export type ResourceReference = z.infer<typeof ResourceReferenceSchema>;
export const ResourceReferencesSchema = z.array(ResourceReferenceSchema).max(50)
  .refine(values => new Set(values.map(value => value.id)).size === values.length, '同一资料不能重复关联');
export const ResourceOwnerSchema = z.strictObject({ entity: z.enum(['task', 'block', 'course', 'goal']), id: identifier });
export type ResourceOwner = z.infer<typeof ResourceOwnerSchema>;
export type ResourceTarget = ResourceOwner;
