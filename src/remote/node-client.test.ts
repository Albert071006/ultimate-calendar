import { describe, expect, it, vi } from 'vitest';
import { createNodeRemoteClient, normalizeRemoteOrigin, type RemoteCredential } from './node-client';

const origin='https://synthetic.example',identity={protocolVersion:1 as const,dataInstanceId:'11111111-1111-4111-8111-111111111111',generation:1},deviceId='22222222-2222-4222-8222-222222222222';
const session={paired:true,identity,device:{id:deviceId,name:'合成Windows'},csrfToken:'synthetic-csrf',aiConfigured:false};
const saved:RemoteCredential={version:1,origin,cookie:'__Host-planner_session=synthetic-private-cookie',identity,deviceId};
const json=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
function setup(respond:(path:string,init:RequestInit)=>Response|Promise<Response>,credential:RemoteCredential|null=saved,timeoutMs?:number){const store={read:()=>credential,write:vi.fn()};const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>respond(new URL(String(url)).pathname,init??{}));return{client:createNodeRemoteClient({origin,credentials:store,fetch:fetcher,timeoutMs}),fetcher,store};}

describe('native Node remote transport',()=>{
  it('adopts only the immediately next identity after explicit successful restore and never uses ordinary retryable RPC',async()=>{
    const next={...identity,generation:2}; const f=setup(path=>path.endsWith('/session')?json(session):json({ok:true,data:{identity:next,backupCreated:true,taskCount:1,courseCount:0,ledgerEntryCount:0}}));
    const input={token:'33333333-3333-4333-8333-333333333333',digest:'a'.repeat(64)};
    await expect(f.client.rpc('restoreConfirm',input)).rejects.toMatchObject({status:400});expect(f.fetcher).not.toHaveBeenCalled();
    expect(await f.client.confirmRestore(input)).toMatchObject({ok:true});expect(f.store.write).toHaveBeenCalledExactlyOnceWith({...saved,identity:next});
    expect(f.fetcher.mock.calls.filter(call=>String(call[0]).endsWith('restoreConfirm'))).toHaveLength(1); f.client.close();
    const bad=setup(path=>path.endsWith('/session')?json(session):json({ok:true,data:{identity:{...next,generation:3},backupCreated:true,taskCount:1,courseCount:0,ledgerEntryCount:0}}));
    await expect(bad.client.confirmRestore(input)).rejects.toMatchObject({status:409});expect(bad.store.write).not.toHaveBeenCalled();bad.client.close();
  });
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

const revision='33333333-3333-4333-8333-333333333333',key='synthetic-cloud-key-never-persist';
const configuration={provider:'deepseek' as const,configured:true,editable:true,source:'managed' as const,revision};
const configJson=(value:unknown=configuration)=>json({ok:true,identity,configuration:value});
describe('native cloud AI configuration transport',()=>{
  it('uses GET, PUT and DELETE outside RPC, preserves identity/revision/CSRF and never writes a key to credentials',async()=>{
    const f=setup((path,init)=>path.endsWith('/session')?json(session):configJson({...configuration,configured:init.method!=='DELETE'}));
    expect(await f.client.getAiConfiguration()).toEqual(configuration);
    expect(await f.client.updateAiConfiguration(' '+key+' ',null)).toEqual(configuration);
    expect(await f.client.clearAiConfiguration(revision)).toEqual({...configuration,configured:false});
    const calls=f.fetcher.mock.calls.slice(1);expect(calls.map(([url,init])=>[url,init!.method])).toEqual([
      [origin+'/api/v1/ai/config','GET'],[origin+'/api/v1/ai/config','PUT'],[origin+'/api/v1/ai/config','DELETE'],
    ]);
    expect(calls[0]![1]).toMatchObject({headers:{Origin:origin,Cookie:saved.cookie},redirect:'error',cache:'no-store'});
    expect(calls[0]![1]!.body).toBeUndefined();
    for(const [,init] of calls.slice(1))expect(init).toMatchObject({headers:{Origin:origin,Cookie:saved.cookie,'Content-Type':'application/json','X-CSRF-Token':'synthetic-csrf'},redirect:'error',cache:'no-store'});
    expect(JSON.parse(String(calls[1]![1]!.body))).toEqual({identity,expectedRevision:null,apiKey:key});
    expect(JSON.parse(String(calls[2]![1]!.body))).toEqual({identity,expectedRevision:revision});
    expect(f.store.write).not.toHaveBeenCalled();f.client.close();
  });
  it('requires a valid explicit revision and key before any network activity',async()=>{
    const f=setup(()=>configJson());
    await expect(f.client.updateAiConfiguration(key,undefined as never)).rejects.toMatchObject({status:400});
    await expect(f.client.clearAiConfiguration('invalid' as never)).rejects.toMatchObject({status:400});
    await expect(f.client.updateAiConfiguration('has spaces in key',null)).rejects.toMatchObject({status:400});
    expect(f.fetcher).not.toHaveBeenCalled();expect(f.store.write).not.toHaveBeenCalled();f.client.close();
  });
  it('checks device identity before sending a configuration write',async()=>{
    for(const response of [{paired:false},{...session,identity:{...identity,generation:2}}]){
      const f=setup(()=>json(response));await expect(f.client.updateAiConfiguration(key,null)).rejects.toMatchObject({status:'paired' in response&&response.paired?409:401});
      expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.fetcher.mock.calls[0]![1]!.body).toBeUndefined();f.client.close();
    }
  });
  it.each([401,403,409])('preserves HTTP %i with fixed safe errors and never repeats a write',async status=>{
    const f=setup(path=>path.endsWith('/session')?json(session):new Response(key,{status,headers:{'content-type':'text/plain'}}));
    const error=await f.client.updateAiConfiguration(key,revision).catch(error=>error);
    expect(error).toMatchObject({status});expect(error.message).not.toContain(key);expect(f.fetcher).toHaveBeenCalledTimes(2);expect(f.store.write).not.toHaveBeenCalled();f.client.close();
  });
  it('does not resend a timed out PUT; an explicit reread only GETs the current state',async()=>{
    const f=setup((path,init)=>path.endsWith('/session')?json(session):init.method==='PUT'?new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true})):configJson(),saved,100);
    await expect(f.client.updateAiConfiguration(key,null)).rejects.toMatchObject({status:0,message:expect.stringContaining('不会自动重发')});
    expect(f.fetcher).toHaveBeenCalledTimes(2);expect(await f.client.getAiConfiguration()).toEqual(configuration);
    expect(f.fetcher.mock.calls.map(([,init])=>init!.method)).toEqual(['GET','PUT','GET']);expect(f.store.write).not.toHaveBeenCalled();f.client.close();
  });
  it('does not resend a DELETE after an ambiguous connection failure',async()=>{
    const f=setup(path=>{if(path.endsWith('/session'))return json(session);throw new Error('transport '+key);});
    const error=await f.client.clearAiConfiguration(revision).catch(error=>error);expect(error).toMatchObject({status:0});expect(error.message).not.toContain(key);
    expect(f.fetcher).toHaveBeenCalledTimes(2);expect(f.fetcher.mock.calls[1]![1]!.method).toBe('DELETE');f.client.close();
  });
  it('refuses redirects and TLS failures without forwarding a key or cookie to another origin',async()=>{
    for(const redirect of [true,false]){
      const f=setup(path=>{if(path.endsWith('/session'))return json(session);if(redirect)return json({},307,{location:'http://untrusted.example/steal'});throw Object.assign(new Error(key),{cause:{code:'CERT_HAS_EXPIRED'}});});
      const error=await f.client.updateAiConfiguration(key,null).catch(error=>error);expect(error).toMatchObject({status:redirect?502:0});expect(error.message).not.toContain(key);
      expect(f.fetcher).toHaveBeenCalledTimes(2);for(const [url,init] of f.fetcher.mock.calls){expect(String(url).startsWith(origin+'/')).toBe(true);expect(init!.redirect).toBe('error');}
      expect(f.store.write).not.toHaveBeenCalled();f.client.close();
    }
  });
  it('rejects a malformed status or an echoed key instead of returning credentials to the renderer',async()=>{
    const f=setup(path=>path.endsWith('/session')?json(session):configJson({...configuration,apiKey:key}));
    const error=await f.client.getAiConfiguration().catch(error=>error);expect(error).toMatchObject({status:502});expect(error.message).not.toContain(key);f.client.close();
  });
  it('rejects a configuration response belonging to another data identity without replaying the request',async()=>{
    const f=setup(path=>path.endsWith('/session')?json(session):json({ok:true,identity:{...identity,generation:2},configuration}));
    await expect(f.client.updateAiConfiguration(key,revision)).rejects.toMatchObject({status:409});
    expect(f.fetcher).toHaveBeenCalledTimes(2);expect(f.store.write).not.toHaveBeenCalled();f.client.close();
  });
});
