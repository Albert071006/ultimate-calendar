import { afterEach, expect, it, vi } from 'vitest';
import * as transport from './loopback-https';
import { createNodeRemoteClient } from './node-client';

afterEach(() => vi.restoreAllMocks());
it('uses and disposes the explicit loopback HTTPS transport while retaining the paired origin and cookie', async () => {
  const origin = 'https://calendar.synthetic.invalid';
  const identity = { protocolVersion: 1 as const, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 }, deviceId = '22222222-2222-4222-8222-222222222222';
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ paired: true, identity, device: { id: deviceId, name: '合成电脑' }, csrfToken: 'synthetic-csrf', aiConfigured: false }), { headers: { 'content-type': 'application/json' } }));
  const close = vi.fn(), factory = vi.spyOn(transport, 'createLoopbackHttpsTransport').mockReturnValue({ fetch: fetcher, close });
  const client = createNodeRemoteClient({ origin, localConnectAddress: '127.0.0.1', credentials: { read: () => ({ version: 1, origin, identity, deviceId, cookie: '__Host-planner_session=synthetic' }), write: vi.fn() } });
  expect(factory).toHaveBeenCalledExactlyOnceWith({ origin, localConnectAddress: '127.0.0.1' });
  expect(await client.getSession()).toEqual({ identity, deviceId, aiConfigured: false });
  expect(fetcher).toHaveBeenCalledWith(origin + '/api/v1/session', expect.objectContaining({ redirect: 'error', headers: { Origin: origin, Cookie: '__Host-planner_session=synthetic' } }));
  client.close(); expect(close).toHaveBeenCalledOnce();
});

it('does not allow a custom fetcher to silently bypass an explicit loopback route', () => {
  expect(() => createNodeRemoteClient({ origin: 'https://calendar.synthetic.invalid', localConnectAddress: '127.0.0.1', fetch: vi.fn(), credentials: { read: () => null, write: vi.fn() } })).toThrow(/不能同时/);
});
