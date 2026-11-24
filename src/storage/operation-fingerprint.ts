import { createHash } from 'node:crypto';

export const privateOperationFingerprint = (serialized: string) =>
  'redacted:' + createHash('sha256').update(serialized).digest('hex');
