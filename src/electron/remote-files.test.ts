import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotSchema } from '../shared/contracts';
import type { NodeRemoteClient } from '../remote/node-client';
import { createRemoteFiles } from './remote-files';

const dialogs=vi.hoisted(()=>({open:vi.fn(),save:vi.fn()}));
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()},dialog:{showOpenDialog:dialogs.open,showSaveDialog:dialogs.save}}));
const roots:string[]=[];
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>{for(const path of roots.splice(0)){const delta=relative(tmpdir(),path);if(!delta||delta.startsWith('..')||isAbsolute(delta))throw Error('Unsafe cleanup');rmSync(path,{recursive:true,force:true});}});
function fixture(){const root=mkdtempSync(join(tmpdir(),'calendar-remote-files-'));roots.push(root);const rpc=vi.fn(),confirmRestore=vi.fn(),clientRpc=vi.fn();return{root,rpc,confirmRestore,clientRpc,files:createRemoteFiles({window:{} as never,rpc,client:{rpc:clientRpc,confirmRestore} as unknown as NodeRemoteClient,canRestore:async()=>true})};}
it('parses selected course files locally using current shared term settings without uploading the file',async()=>{
  const f=fixture(),path=join(f.root,'courses.csv');writeFileSync(path,'课程,星期,开始,结束,起始周,结束周,单双周,地点\n合成课程,1,08:00,09:30,1,16,全,A101');dialogs.open.mockResolvedValue({canceled:false,filePaths:[path]});
  f.rpc.mockResolvedValue({ok:true,data:SnapshotSchema.parse({schemaVersion:1,sources:[],candidates:[],tasks:[],blocks:[],goals:[],courses:[],courseExceptions:[],preferences:[],feedback:[],settings:{termStart:'2026-09-07'},journal:[],tokenUsage:[],keyStatus:{configured:false,sessionOnly:false}})});
  const result=await f.files.handle('importCourses',{kind:'file',operationId:'synthetic-preview'});
  expect(result).toMatchObject({ok:true,data:{courses:[{title:'合成课程',termStart:'2026-09-07'}]}});expect(f.rpc).toHaveBeenCalledExactlyOnceWith('snapshot');expect(f.clientRpc).not.toHaveBeenCalled();
});
it('downloads the canonical ledger to the selected file and reports cloud backups without original sources',async()=>{
  const f=fixture(),path=join(f.root,'ledger.json');dialogs.save.mockResolvedValue({canceled:false,filePath:path});f.rpc.mockResolvedValue({ok:true,data:{format:'json',content:'{"formal":"synthetic"}'}});
  expect(await f.files.handle('ledgerExport',{format:'json'})).toEqual({ok:true,data:{path}});expect(readFileSync(path,'utf8')).toBe('{"formal":"synthetic"}');expect(f.rpc).toHaveBeenCalledWith('ledgerExportData',{format:'json'});
  f.rpc.mockResolvedValue({ok:true,data:{content:'{"backup":"synthetic"}'}});expect(await f.files.handle('backup')).toMatchObject({ok:true,data:{includesSources:false}});
});
it('does not transmit a local raw or SQLite backup disguised as JSON',async()=>{
  const f=fixture(),path=join(f.root,'not-safe.json');writeFileSync(path,JSON.stringify({privateQQ:'synthetic local raw'}));dialogs.open.mockResolvedValue({canceled:false,filePaths:[path]});
  await expect(f.files.handle('restore',{confirmed:false})).rejects.toMatchObject({code:'VALIDATION'});expect(f.clientRpc).not.toHaveBeenCalled();expect(f.confirmRestore).not.toHaveBeenCalled();
});
it('does not write an error response or report a cancelled save as success',async()=>{
  const f=fixture();f.rpc.mockResolvedValue({ok:false,error:{code:'NETWORK',message:'Synthetic unavailable',retryable:true}});
  expect(await f.files.handle('backup')).toMatchObject({ok:false});expect(dialogs.save).not.toHaveBeenCalled();
  f.rpc.mockResolvedValue({ok:true,data:{content:'{}'}});dialogs.save.mockResolvedValue({canceled:true});await expect(f.files.handle('backup')).rejects.toMatchObject({code:'CANCELLED'});
});
