import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotSchema } from '../shared/contracts';
import { RemoteClientError, type NodeRemoteClient } from '../remote/node-client';
import { CLOUD_BACKUP_CHUNK_BYTES } from '../shared/cloud-management';
import { emptyState } from '../storage/repository';
import { DEFAULT_LEDGER_RULES } from '../shared/ledger';
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
  const content = JSON.stringify({format:'ultimate-calendar-safe-backup',formatVersion:1,createdAt:'2026-04-01T00:00:00Z',planner:emptyState(),
    ledger:{format:'ultimate-calendar-ledger',formatVersion:1,entries:[],balanceSnapshots:[],rules:DEFAULT_LEDGER_RULES,audit:[],sources:[]}});
  f.rpc.mockRejectedValueOnce(new RemoteClientError(400,'Unknown RPC')).mockResolvedValue({ok:true,data:{content}});
  expect(await f.files.handle('backup')).toMatchObject({ok:true,data:{includesSources:false}});
  expect(f.rpc).toHaveBeenLastCalledWith('backupExportData');expect(readFileSync(path,'utf8')).toBe(content);
});
it('does not transmit a local raw or SQLite backup disguised as JSON',async()=>{
  const f=fixture(),path=join(f.root,'not-safe.json');writeFileSync(path,JSON.stringify({privateQQ:'synthetic local raw'}));dialogs.open.mockResolvedValue({canceled:false,filePaths:[path]});
  await expect(f.files.handle('restore',{confirmed:false})).rejects.toMatchObject({code:'VALIDATION'});expect(f.clientRpc).not.toHaveBeenCalled();expect(f.confirmRestore).not.toHaveBeenCalled();
});
it('does not write an error response or report a cancelled save as success',async()=>{
  const f=fixture();f.rpc.mockResolvedValue({ok:false,error:{code:'NETWORK',message:'Synthetic unavailable',retryable:true}});
  expect(await f.files.handle('backup')).toMatchObject({ok:false});expect(dialogs.save).not.toHaveBeenCalled();
  const downloadId=crypto.randomUUID();
  f.rpc.mockResolvedValue({ok:true,data:{downloadId,sha256:'0'.repeat(64),totalBytes:2,chunkBytes:CLOUD_BACKUP_CHUNK_BYTES}});
  dialogs.save.mockResolvedValue({canceled:true});await expect(f.files.handle('backup')).rejects.toMatchObject({code:'CANCELLED'});
  expect(f.rpc).toHaveBeenLastCalledWith('backupExportFinish',{downloadId});
});
it('preserves an existing export when a download returns a chunk for a different offset',async()=>{
  const f=fixture(),path=join(f.root,'backup.json'),downloadId=crypto.randomUUID();
  writeFileSync(path,'prior verified backup');
  dialogs.save.mockResolvedValue({canceled:false,filePath:path});
  f.rpc.mockResolvedValueOnce({ok:true,data:{downloadId,totalBytes:2,sha256:'0'.repeat(64),chunkBytes:CLOUD_BACKUP_CHUNK_BYTES}})
    .mockResolvedValueOnce({ok:true,data:{downloadId,offset:1,data:Buffer.from('{}').toString('base64')}});
  await expect(f.files.handle('backup')).rejects.toThrow();
  expect(f.rpc).toHaveBeenCalledTimes(3);expect(f.rpc).toHaveBeenLastCalledWith('backupExportFinish',{downloadId});
  expect(readFileSync(path,'utf8')).toBe('prior verified backup');
  expect(readdirSync(f.root)).toEqual(['backup.json']);
});
