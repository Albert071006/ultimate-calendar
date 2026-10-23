import { parentPort, workerData } from 'node:worker_threads';
import { extractDocument } from './index';
if (!parentPort) throw new Error('Document worker requires a parent port');
const input = workerData as { bytes: Uint8Array; name: string; mime?: string };
void extractDocument({ ...input, bytes: Buffer.from(input.bytes) }).then(result => parentPort!.postMessage(result));
