import { z } from 'zod';
import type { ApiResult } from './contracts';
import { ResourceReferenceSchema, type ResourceReference } from './resources';

export const ResourcePickRequestSchema = z.strictObject({ kind: z.enum(['file', 'folder']) });
export const ResourceRegisterRequestSchema = z.strictObject({ paths: z.array(z.string().min(1).max(32768)).min(1).max(50) });
export const ResourceOpenRequestSchema = z.strictObject({ resource: ResourceReferenceSchema });
export const ResourceStatusRequestSchema = z.strictObject({ resources: z.array(ResourceReferenceSchema).max(500) });
export const ResourceStatusSchema = z.strictObject({ id: z.string(), status: z.enum(['available', 'missing', 'other-device', 'unregistered', 'blocked']) });
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>;
export interface ResourceDesktopAPI {
  resourcePick?(request: z.infer<typeof ResourcePickRequestSchema>): Promise<ApiResult<ResourceReference[]>>;
  resourceRegister?(request: z.infer<typeof ResourceRegisterRequestSchema>): Promise<ApiResult<ResourceReference[]>>;
  /** Actual native File objects only; preload resolves paths and never exposes a filesystem API. */
  resourceDrop?(files: File[]): Promise<ApiResult<ResourceReference[]>>;
  resourceOpen?(request: z.infer<typeof ResourceOpenRequestSchema>): Promise<ApiResult<{ opened: true }>>;
  resourceRelocate?(request: z.infer<typeof ResourceOpenRequestSchema>): Promise<ApiResult<ResourceReference | null>>;
  resourceStatus?(request: z.infer<typeof ResourceStatusRequestSchema>): Promise<ApiResult<ResourceStatus[]>>;
}
