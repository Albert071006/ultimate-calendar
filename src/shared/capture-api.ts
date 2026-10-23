import { z } from 'zod';
import { IdSchema, ImageDataUrlSchema, type ApiResult } from './contracts';
import { CaptureConfigSchema, CaptureCleanupRequestSchema, CapturePageRequestSchema, CaptureGroupSchema, CaptureSnapshotSchema, CaptureMessagePageSchema, CaptureBatchPageSchema } from './capture';

export const CaptureConnectSchema = z.strictObject({ token: z.string().trim().min(1).max(8192).refine(v => !/[\r\n]/.test(v)).optional(), detect: z.boolean().optional() });
export const CaptureActionSchema = z.strictObject({ action: z.enum(['analyze', 'backfill', 'retry', 'reanalyze', 'disconnect']), batchId: IdSchema.optional() }).refine(v => !['retry', 'reanalyze'].includes(v.action) || !!v.batchId);
export const CaptureChunksRequestSchema = z.strictObject({ attachmentId: IdSchema, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(5) });
export const CaptureChunksSchema = z.strictObject({ items: z.array(z.strictObject({ id: IdSchema, locator: z.string().max(1000), text: z.string().max(1_000_000), imageDataUrl: ImageDataUrlSchema.nullable(), status: z.string(), error: z.string().nullable() })), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive() });
export interface CaptureDesktopAPI {
  captureSnapshot(): Promise<ApiResult<z.infer<typeof CaptureSnapshotSchema>>>;
  captureConfigure(config: z.input<typeof CaptureConfigSchema>): Promise<ApiResult<z.infer<typeof CaptureSnapshotSchema>>>;
  captureConnect(request: z.input<typeof CaptureConnectSchema>): Promise<ApiResult<z.infer<typeof CaptureSnapshotSchema>>>;
  captureGroups(): Promise<ApiResult<z.infer<typeof CaptureGroupSchema>[]>>;
  captureMessages(request: z.input<typeof CapturePageRequestSchema>): Promise<ApiResult<z.infer<typeof CaptureMessagePageSchema>>>;
  captureBatches(request: z.input<typeof CapturePageRequestSchema>): Promise<ApiResult<z.infer<typeof CaptureBatchPageSchema>>>;
  captureAction(request: z.input<typeof CaptureActionSchema>): Promise<ApiResult<z.infer<typeof CaptureSnapshotSchema>>>;
  captureChunks(request: z.input<typeof CaptureChunksRequestSchema>): Promise<ApiResult<z.infer<typeof CaptureChunksSchema>>>;
  captureCleanup(request: z.input<typeof CaptureCleanupRequestSchema>): Promise<ApiResult<z.infer<typeof CaptureSnapshotSchema>>>;
  onCaptureChanged(listener: (snapshot: z.infer<typeof CaptureSnapshotSchema>) => void): () => void;
}
