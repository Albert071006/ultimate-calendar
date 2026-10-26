import { z } from 'zod';
import { IdSchema, type ApiResult } from './contracts';

/** Local host capability only: no file paths, locators or bytes cross this boundary. */
export const SourceAttachmentsRequestSchema = z.strictObject({ sourceIds: z.array(IdSchema).min(1).max(100) });
export const SourceAttachmentOpenRequestSchema = SourceAttachmentsRequestSchema.extend({ attachmentId: IdSchema });
export const SourceAttachmentSchema = z.strictObject({
  id: IdSchema, name: z.string().min(1).max(240),
  status: z.enum(['available', 'missing', 'unsupported']), message: z.string().max(500).optional(),
});
export const SourceAttachmentsResultSchema = z.strictObject({ attachments: z.array(SourceAttachmentSchema).max(100), unavailableSources: z.number().int().nonnegative().max(100) });
export const SourceAttachmentOpenResultSchema = z.strictObject({ opened: z.literal(true) });
export type SourceAttachmentsRequest = z.infer<typeof SourceAttachmentsRequestSchema>;
export type SourceAttachmentOpenRequest = z.infer<typeof SourceAttachmentOpenRequestSchema>;
export type SourceAttachment = z.infer<typeof SourceAttachmentSchema>;
export type SourceAttachmentsResult = z.infer<typeof SourceAttachmentsResultSchema>;
export interface SourceAttachmentDesktopAPI {
  sourceAttachments(request: SourceAttachmentsRequest): Promise<ApiResult<SourceAttachmentsResult>>;
  sourceAttachmentOpen(request: SourceAttachmentOpenRequest): Promise<ApiResult<z.infer<typeof SourceAttachmentOpenResultSchema>>>;
}
