import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createNodeRemoteClient, type RemoteCredential } from './node-client';
const identity={protocolVersion:1 as const,dataInstanceId:'11111111-1111-4111-8111-111111111111',generation:1};
const deviceId='22222222-2222-4222-8222-222222222222',origin='https://synthetic.example';
const credential:RemoteCredential={version:1,origin,deviceId,identity,cookie:'__Host-planner_session=synthetic-private-cookie'};
const input={keyId:'a'.repeat(64),nonce:randomBytes(32).toString('base64url')};
const envelope={version:1 as const,deviceId,...input,revision:'33333333-3333-4333-8333-333333333333',wrappedKey:Buffer.alloc(384).toString('base64url'),iv:Buffer.alloc(12).toString('base64url'),ciphertext:Buffer.from('synthetic-ciphertext').toString('base64url'),tag:Buffer.alloc(16).toString('base64url')};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function fixture(reply:()=>Response|Promise<Response>){const write=vi.fn();const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith('/session')?json({paired:true,identity,device:{id:deviceId,name:'合成采集端'},csrfToken:'synthetic-csrf',aiConfigured:true}):reply());const client=createNodeRemoteClient({origin,credentials:{read:()=>credential,write},fetch:fetcher});return{client,fetcher,write};}
describe('encrypted receiver transport',()=>{
  it('uses the paired identity and CSRF once without storing returned credentials',async()=>{
    const f=fixture(()=>json({ok:true,identity,envelope}));
    try{expect(await f.client.syncAiKeyReceiver(input)).toEqual({ok:true,identity,envelope});
      expect(f.fetcher.mock.calls[1]?.[0]).toBe(origin+'/api/v1/ai/receiver/sync');
      const request=(f.fetcher.mock.calls[1] as unknown as [string,RequestInit])[1];
      expect(request).toMatchObject({redirect:'error',method:'POST',headers:{Origin:origin,Cookie:credential.cookie,'X-CSRF-Token':'synthetic-csrf'}});
      expect(JSON.parse(String(request.body))).toEqual({...input,identity});expect(f.write).not.toHaveBeenCalled();
    }finally{f.client.close();}
  });
  it.each(['identity','device','nonce','keyId'] as const)('refuses mismatched %s bindings',async(field)=>{
    const value={ok:true,identity,envelope:{...envelope}};
    if(field==='identity')value.identity={...identity,generation:2};
    if(field==='device')value.envelope.deviceId='44444444-4444-4444-8444-444444444444';
    if(field==='nonce')value.envelope.nonce=randomBytes(32).toString('base64url');
    if(field==='keyId')value.envelope.keyId='b'.repeat(64);
    const f=fixture(()=>json(value));try{await expect(f.client.syncAiKeyReceiver(input)).rejects.toMatchObject({status:409});expect(f.write).not.toHaveBeenCalled();}finally{f.client.close();}
  });
  it('does not parse echoed secrets on errors or retry denied distribution',async()=>{
    const f=fixture(()=>json({apiKey:'synthetic-secret-must-not-surface'},403));
    try{await expect(f.client.syncAiKeyReceiver(input)).rejects.not.toThrow('synthetic-secret');expect(f.fetcher).toHaveBeenCalledTimes(2);expect(f.write).not.toHaveBeenCalled();}finally{f.client.close();}
  });
  it('rejects oversized success responses',async()=>{
    const f=fixture(()=>json({ok:true,padding:'x'.repeat(33*1024)}));try{await expect(f.client.syncAiKeyReceiver(input)).rejects.toMatchObject({status:502});}finally{f.client.close();}
  });
});
