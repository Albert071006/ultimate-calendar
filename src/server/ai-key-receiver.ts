import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { privatePath, readPrivate } from '../remote/private-file';
import { AiKeySyncKeyIdSchema, AiKeySyncPlaintextSchema, AiKeySyncResponseSchema, aiKeySyncAad, type AiKeySyncPlaintext, type AiKeySyncRequest, type AiKeySyncResponse } from '../shared/ai-key-sync';
import { RemoteFault } from './state';

export const AiKeyReceiverSchema = z.strictObject({
  deviceId: z.string().uuid(),
  publicKeySpki: z.string().min(1).max(2048),
  keyId: AiKeySyncKeyIdSchema,
  expiresAt: z.string().datetime().nullable().optional(),
  revoked: z.boolean(),
});
export type AiKeyReceiver = z.infer<typeof AiKeyReceiverSchema>;
export const AiKeyReceiverConfigurationSchema = z.strictObject({
  version: z.literal(1),
  receivers: z.array(AiKeyReceiverSchema).max(64),
}).refine(value => new Set(value.receivers.map(receiver => receiver.deviceId)).size === value.receivers.length
  && new Set(value.receivers.map(receiver => receiver.keyId)).size === value.receivers.length);
export type AiKeyReceiverConfiguration = z.infer<typeof AiKeyReceiverConfigurationSchema>;

function storageFailure(): RemoteFault { return new RemoteFault(503, '密钥接收授权文件不可用，请检查服务端私密文件状态'); }
function denied(): RemoteFault { return new RemoteFault(403, '此设备未获得有效的密钥接收授权'); }

/** RSA3072 SPKI only; hashing canonical DER makes PEM formatting immaterial. */
export function aiKeyReceiverPublicKey(value: string): { publicKey: KeyObject; keyId: string } {
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(value)) throw storageFailure();
  const publicKey = createPublicKey(value);
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails?.modulusLength !== 3072
    || publicKey.asymmetricKeyDetails.publicExponent !== 65537n) throw storageFailure();
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { publicKey, keyId };
}

/** Reload on every use so local revocation applies without a service restart. No HTTP enrollment. */
export function createAiKeyReceiver(file: string, now: () => number = Date.now) {
  function authorized(deviceId: string, keyId: string): KeyObject {
    let configuration: AiKeyReceiverConfiguration;
    try {
      const path = privatePath(file);
      // Reject dangling symlinks too: readPrivate's existence check follows links.
      for (let current = path; ; current = dirname(current)) {
        try { if (lstatSync(current).isSymbolicLink()) throw storageFailure(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (dirname(current) === current) break;
      }
      const bytes = readPrivate(path, 256 * 1024);
      configuration = bytes === null ? { version: 1, receivers: [] } : AiKeyReceiverConfigurationSchema.parse(JSON.parse(bytes.toString('utf8')));
      // Validate the whole registry, including currently unused bindings, to fail closed on damage.
      const keys = new Map(configuration.receivers.map(receiver => {
        const key = aiKeyReceiverPublicKey(receiver.publicKeySpki);
        if (key.keyId !== receiver.keyId) throw storageFailure();
        return [receiver.deviceId, key.publicKey];
      }));
      const receiver = configuration.receivers.find(value => value.deviceId === deviceId && value.keyId === keyId);
      if (!receiver || receiver.revoked || receiver.expiresAt && Date.parse(receiver.expiresAt) <= now()) throw denied();
      return keys.get(receiver.deviceId)!;
    } catch (error) { if (error instanceof RemoteFault && error.status === 403) throw error; throw storageFailure(); }
  }
  return {
    authorize: authorized,
    seal(deviceId: string, request: AiKeySyncRequest, snapshot: AiKeySyncPlaintext): AiKeySyncResponse {
      const publicKey = authorized(deviceId, request.keyId);
      // Do not forward parsing/crypto error messages: injected stores may contain credentials.
      let plaintext: Buffer | undefined, symmetricKey: Buffer | undefined;
      try {
        const value = AiKeySyncPlaintextSchema.parse(snapshot);
        const binding = { version: 1 as const, deviceId, keyId: request.keyId, nonce: request.nonce, revision: value.revision };
        symmetricKey = randomBytes(32); const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', symmetricKey, iv);
        cipher.setAAD(Buffer.from(aiKeySyncAad(request.identity, binding), 'utf8'));
        plaintext = Buffer.from(JSON.stringify(value), 'utf8');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, symmetricKey);
        return AiKeySyncResponseSchema.parse({ ok: true, identity: request.identity, envelope: {
          ...binding, wrappedKey: wrappedKey.toString('base64url'), iv: iv.toString('base64url'),
          ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'),
        } });
      } catch { throw new RemoteFault(503, '加密凭据同步暂不可用'); }
      finally { symmetricKey?.fill(0); plaintext?.fill(0); }
    },
  };
}
