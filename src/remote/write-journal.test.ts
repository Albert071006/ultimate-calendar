import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteJournal } from './write-journal';
import type { NodeRemoteClient } from './node-client';
import { writePrivate } from './private-file';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0)){const part=relative(tmpdir(),root);if(!part||part.startsWith('..')||isAbsolute(part))throw Error('Unsafe synthetic cleanup');rmSync(root,{recursive:true,force:true});}});
const identity={protocolVersion:1 as const,dataInstanceId:'11111111-1111-4111-8111-111111111111',generation:1},deviceId='22222222-2222-4222-8222-222222222222';
const input=(operationId:string,title='合成私密标题')=>({operationId,origin:'manual',mutations:[{type:'create',entity:'task',values:{title}}]});
const result={ok:true as const,data:{status:'applied' as const,message:'已保存',changes:[],conflicts:[],transactionId:'synthetic-tx'}};
function fixture(){const root=mkdtempSync(join(tmpdir(),'calendar-native-journal-'));roots.push(root);const client={origin:'https://synthetic.example',getSession:vi.fn(async()=>({identity,deviceId,aiConfigured:false})),rpc:vi.fn(async()=>result),operation:vi.fn(async()=>({status:'unknown'}))} as unknown as NodeRemoteClient;return{file:join(root,'remote-write.json'),client};}

describe('native durable write guard',()=>{
  it('rejects invalid input before creating a durable guard and remains usable for the next valid write',async()=>{const f=fixture(),journal=createWriteJournal(f.client,f.file);await expect(journal.rpc('mutate',{operationId:'synthetic-invalid',origin:'manual',mutations:[{type:'create',entity:'task',values:{title:''}}]})).rejects.toThrow();expect(existsSync(f.file)).toBe(false);expect(f.client.getSession).not.toHaveBeenCalled();expect(f.client.rpc).not.toHaveBeenCalled();expect(await journal.rpc('mutate',input('valid-business'))).toEqual(result);expect(f.client.rpc).toHaveBeenCalledTimes(1);});
  it('recovers a committed response after restart without a second mutation, despite a fresh business operationId',async()=>{
    const f=fixture();vi.mocked(f.client.rpc).mockRejectedValueOnce(Error('Synthetic dropped response after commit'));
    await expect(createWriteJournal(f.client,f.file).rpc('mutate',input('first-business-id'))).rejects.toThrow('dropped');
    const saved=JSON.parse(readFileSync(f.file,'utf8'));expect(readFileSync(f.file,'utf8')).not.toContain('合成私密标题');
    vi.mocked(f.client.operation).mockResolvedValue({status:'completed',requestId:saved.requestId,method:'mutate',result});
    expect(await createWriteJournal(f.client,f.file).rpc('mutate',input('fresh-business-id'))).toEqual(result);expect(f.client.rpc).toHaveBeenCalledTimes(1);expect(f.client.operation).toHaveBeenCalledWith(saved.requestId);expect(JSON.parse(readFileSync(f.file,'utf8'))).toBeNull();
  });
  it('resends an unknown original request with both original IDs and blocks a different intent',async()=>{
    const f=fixture();vi.mocked(f.client.rpc).mockRejectedValueOnce(Error('Synthetic failed before server received request'));
    await expect(createWriteJournal(f.client,f.file).rpc('mutate',input('original-business-id'))).rejects.toThrow();const saved=JSON.parse(readFileSync(f.file,'utf8'));
    const restarted=createWriteJournal(f.client,f.file);await expect(restarted.rpc('mutate',input('other-id','不同意图'))).rejects.toMatchObject({status:409});expect(f.client.rpc).toHaveBeenCalledTimes(1);
    await restarted.rpc('mutate',input('new-business-id'));expect(f.client.rpc).toHaveBeenLastCalledWith('mutate',expect.objectContaining({operationId:'original-business-id'}),saved.requestId);expect(f.client.rpc).toHaveBeenCalledTimes(2);
  });
  it('never clears processing or interrupted protection without an explicit permitted acknowledgement',async()=>{
    const f=fixture();vi.mocked(f.client.rpc).mockRejectedValueOnce(Error('Synthetic drop'));const journal=createWriteJournal(f.client,f.file);await expect(journal.rpc('mutate',input('business'))).rejects.toThrow();const saved=JSON.parse(readFileSync(f.file,'utf8'));
    vi.mocked(f.client.operation).mockResolvedValue({status:'processing',requestId:saved.requestId,method:'mutate'});await expect(journal.acknowledge(saved.requestId)).rejects.toMatchObject({status:409});await expect(journal.rpc('mutate',input('new-id'))).rejects.toMatchObject({status:409});
    vi.mocked(f.client.operation).mockResolvedValue({status:'interrupted',requestId:saved.requestId,method:'mutate'});await expect(journal.rpc('mutate',input('another-id'))).rejects.toMatchObject({status:409});expect(f.client.rpc).toHaveBeenCalledTimes(1);
    await journal.acknowledge(saved.requestId);expect(JSON.parse(readFileSync(f.file,'utf8'))).toBeNull();expect(JSON.parse(readFileSync(f.file+'.last-acknowledged','utf8'))).toMatchObject({status:'interrupted',requestId:saved.requestId});
  });
  it('blocks a persisted original-device request when the service generation changes',async()=>{
    const f=fixture();vi.mocked(f.client.rpc).mockRejectedValueOnce(Error('Synthetic drop'));await expect(createWriteJournal(f.client,f.file).rpc('mutate',input('business'))).rejects.toThrow();vi.mocked(f.client.getSession).mockResolvedValue({identity:{...identity,generation:2},deviceId,aiConfigured:false});
    await expect(createWriteJournal(f.client,f.file).rpc('mutate',input('new-business'))).rejects.toMatchObject({status:409});expect(f.client.rpc).toHaveBeenCalledTimes(1);expect(f.client.operation).not.toHaveBeenCalled();
  });
  it('exposes the pending business ID so file imports cannot adopt an unrelated identical write',async()=>{
    const f=fixture();vi.mocked(f.client.rpc).mockRejectedValueOnce(Error('Synthetic drop'));
    const journal=createWriteJournal(f.client,f.file);await expect(journal.rpc('mutate',input('original-manual-id'))).rejects.toThrow();
    expect(await journal.inspect()).toMatchObject({status:'unknown',method:'mutate',operationId:'original-manual-id'});
  });
  it('fails closed on an unreadable persisted journal instead of silently starting a new write',()=>{const f=fixture();writePrivate(f.file,'{broken');expect(()=>createWriteJournal(f.client,f.file)).toThrow();expect(f.client.rpc).not.toHaveBeenCalled();});
});
