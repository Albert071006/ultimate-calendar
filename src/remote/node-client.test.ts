import { describe, expect, it, vi } from 'vitest';
import { createNodeRemoteClient, normalizeRemoteOrigin, type RemoteCredential } from './node-client';

const origin='https://synthetic.example',identity={protocolVersion:1 as const,dataInstanceId:'11111111-1111-4111-8111-111111111111',generation:1},deviceId='22222222-2222-4222-8222-222222222222';
const session={paired:true,identity,device:{id:deviceId,name:'合成Windows'},csrfToken:'synthetic-csrf',aiConfigured:false};
const saved:RemoteCredential={version:1,origin,cookie:'__Host-planner_session=synthetic-private-cookie',identity,deviceId};
const json=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
function setup(respond:(path:string,init:RequestInit)=>Response|Promise<Response>,credential:RemoteCredential|null=saved){const store={read:()=>credential,write:vi.fn()};const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>respond(new URL(String(url)).pathname,init??{}));return{client:createNodeRemoteClient({origin,credentials:store,fetch:fetcher}),fetcher,store};}

describe('native Node remote transport',()=>{
  it('normalizes only HTTPS roots or explicit localhost HTTP and never follows a redirect with a cookie',async()=>{
    for(const value of ['http://public.example','https://user:password@synthetic.example','https://synthetic.example/path','https://synthetic.example/?x=1'])expect(()=>normalizeRemoteOrigin(value)).toThrow();
    expect(normalizeRemoteOrigin('http://localhost:3210/')).toBe('http://localhost:3210');
    const f=setup(()=>json({},302,{location:'https://elsewhere.example/'}));await expect(f.client.getSession()).rejects.toMatchObject({status:502});expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.fetcher.mock.calls[0]![1]).toMatchObject({redirect:'error',headers:{Origin:origin,Cookie:saved.cookie}});f.client.close();
  });
  it('keeps cookie and CSRF solely in main-process request headers and pins the paired identity',async()=>{
    const f=setup(path=>path.endsWith('/session')?json(session):json({status:'unknown'}));
    expect(await f.client.getSession()).toEqual({identity,deviceId,aiConfigured:false});await f.client.operation('synthetic-request');
    const second=f.fetcher.mock.calls[1]![1]!;expect(second.headers).toMatchObject({Cookie:saved.cookie,Origin:origin});expect(JSON.stringify(second.body)??'').not.toContain('synthetic-private-cookie');
    const changed=setup(()=>json({...session,identity:{...identity,generation:2}}));await expect(changed.client.getSession()).rejects.toMatchObject({status:409});expect(changed.store.write).not.toHaveBeenCalled();
    const other=setup(()=>json({...session,device:{...session.device,id:'33333333-3333-4333-8333-333333333333'}}));await expect(other.client.getSession()).rejects.toMatchObject({status:409});f.client.close();changed.client.close();other.client.close();
  });
  it('does not send an existing cookie during pairing, and requires the origin-appropriate response cookie',async()=>{
    const f=setup(()=>json(session,200,{'set-cookie':'__Host-planner_session=new-synthetic-cookie; Secure; HttpOnly; Path=/; SameSite=Strict'}),null);
    await f.client.pair('synthetic-high-entropy-pairing-code','合成Windows');expect(f.fetcher.mock.calls[0]![1]!.headers).not.toHaveProperty('Cookie');expect(f.store.write).toHaveBeenCalledWith(expect.objectContaining({origin,cookie:'__Host-planner_session=new-synthetic-cookie'}));
    const wrong=setup(()=>json(session,200,{'set-cookie':'planner_dev_session=wrong-cookie; Path=/'}),null);await expect(wrong.client.pair('synthetic-high-entropy-pairing-code','合成')).rejects.toMatchObject({status:502});expect(wrong.store.write).not.toHaveBeenCalled();f.client.close();wrong.client.close();
  });
  it('classifies expired, malformed and non-JSON responses without converting them into confirmed results',async()=>{
    const expired=setup(()=>json({ok:false,error:{message:'expired'}},401));await expect(expired.client.getSession()).rejects.toMatchObject({status:401});
    const malformed=setup(()=>json({paired:true}));await expect(malformed.client.getSession()).rejects.toMatchObject({status:502});
    const html=setup(()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}}));await expect(html.client.getSession()).rejects.toMatchObject({status:502});expired.client.close();malformed.client.close();html.client.close();
  });
  it('sends mutation identity and CSRF but does not accept invalid results as a successful receipt',async()=>{
    const f=setup(path=>path.endsWith('/session')?json(session):json({ok:true,data:{status:'pretend-saved'}}));
    await expect(f.client.rpc('mutate',{operationId:'synthetic-business',origin:'manual',mutations:[{type:'create',entity:'task',values:{title:'合成任务'}}]})).rejects.toMatchObject({status:502});
    expect(f.fetcher.mock.calls[1]![1]!.headers).toMatchObject({'X-CSRF-Token':'synthetic-csrf'});expect(JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body))).toMatchObject({identity});f.client.close();
  });
});
