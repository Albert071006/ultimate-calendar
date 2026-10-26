import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRepository, newEntity, type Repository } from '../storage/repository';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { LedgerEntryDraftSchema } from '../shared/ledger';
import { restoreSafeBackup } from '../server/restore';
import { RemoteState } from '../server/state';
import { exportStoppedWindowsCopy, verifyMigrationBundle } from './export';
import { runMigrationCommand } from './command';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0)){const part=relative(tmpdir(),root);if(!part||part.startsWith('..')||isAbsolute(part))throw Error('Test cleanup escaped synthetic temporary directory');rmSync(root,{recursive:true,force:true});}});
const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'calendar-migration-test-'));roots.push(root);
  const source=join(root,'stopped-copy');mkdirSync(source);const database=join(source,'planner.sqlite');
  const repository=createRepository(database,{automaticBackup:()=>{}}),ledger=createLedgerService(database,{now:()=>new Date('2020-01-03T12:00:00Z')});
  repository.transact(state=>{
    const source=newEntity(state,'source',{kind:'text',text:'SYNTHETIC-QQ-RAW-DO-NOT-EXPORT',label:'虚构原始群名',importedAt:'2020-01-01T10:00:00+08:00',captureRef:{messageId:'SYNTHETIC-MESSAGE-ID',accountId:'SYNTHETIC-QQ-ACCOUNT',groupId:'SYNTHETIC-QQ-GROUP',attachmentId:'SYNTHETIC-ATTACHMENT',locator:'C:\\SyntheticComputer\\QQ-raw.txt',transcribed:false},status:'succeeded'});
    const candidate=newEntity(state,'candidate',{title:'合成提炼事项',sourceIds:[source.id],sourceQuote:'SYNTHETIC-QQ-RAW-DO-NOT-EXPORT'});
    const goal=newEntity(state,'goal',{title:'合成目标'});
    const course=newEntity(state,'course',{title:'合成课程',weekday:1,startTime:'10:00',endTime:'11:00',firstWeek:1,lastWeek:16,termStart:'2020-01-06'});
    const task=newEntity(state,'task',{title:'合成正式任务',candidateId:candidate.id,goalId:goal.id,courseId:course.id});
    newEntity(state,'block',{title:'合成执行时段',kind:'work',taskId:task.id,start:'2020-01-07T10:10:00+08:00',end:'2020-01-07T10:55:00+08:00'});
  });
  const expense=LedgerEntryDraftSchema.parse({id:'synthetic-expense',kind:'expense',date:'2020-01-02',month:'2020-01',title:'合成代垫午餐',category:'餐饮',amountCents:1000,personalCents:500,cashflows:[{accountId:'alipay',deltaCents:-1000}],originalText:'SYNTHETIC-LEDGER-RAW-DO-NOT-EXPORT'});
  ledger.mutate({operationId:'synthetic-expense-write',expectedRevision:0,changes:[{type:'putEntry',expectedVersion:null,entry:expense,confirmDuplicate:false,note:''}]});
  const returned=LedgerEntryDraftSchema.parse({id:'synthetic-return',kind:'aa_return',date:'2020-01-03',month:'2020-01',title:'合成同学返款',category:'返款',amountCents:500,personalCents:0,cashflows:[{accountId:'alipay',deltaCents:500}],relatedEntryIds:[expense.id]});
  ledger.mutate({operationId:'synthetic-return-write',expectedRevision:1,changes:[{type:'putEntry',expectedVersion:null,entry:returned,confirmDuplicate:false,note:''}]});
  ledger.mutate({operationId:'synthetic-balance-write',expectedRevision:2,changes:[{type:'setBalance',snapshot:{id:'synthetic-balance',accountId:'alipay',balanceCents:9500,date:'2020-01-03',asOf:null,coveredEntryIds:[expense.id,returned.id],note:'合成余额',sourceId:null}}]});
  const planner=repository.read(),ledgerBefore=ledger.exportJson();ledger.close();repository.close();
  writeFileSync(join(source,'credentials.dpapi'),'SYNTHETIC-API-KEY-NOT-EXPORT');writeFileSync(join(source,'qq-raw.sqlite'),'SYNTHETIC-QQ-DATABASE-NOT-EXPORT');
  return{root,source,database,planner,ledgerBefore};
}

describe('explicit stopped Windows-copy migration preparation',()=>{
  it('exports a source-preserving safe bundle, validates counts, and restores complete formal relationships to a fresh authority',()=>{
    const f=fixture(),before=digest(f.database),output=join(f.root,'cloud-bundle');
    const result=exportStoppedWindowsCopy({sourceDatabase:f.database,outputDirectory:output,stoppedCopy:true,now:new Date('2026-10-25T01:00:00Z')});
    expect(digest(f.database)).toBe(before);expect(readdirSync(f.source).sort()).toEqual(['credentials.dpapi','planner.sqlite','qq-raw.sqlite']);
    expect(readdirSync(output).sort()).toEqual(['manifest.json','safe-backup.json']);
    const serialized=readFileSync(result.backupFile,'utf8');for(const raw of ['SYNTHETIC-QQ-RAW','SYNTHETIC-LEDGER-RAW','SYNTHETIC-QQ-ACCOUNT','SYNTHETIC-QQ-GROUP','SyntheticComputer','SYNTHETIC-API-KEY','SYNTHETIC-QQ-DATABASE'])expect(serialized).not.toContain(raw);
    expect(serialized).toContain('合成提炼事项');expect(serialized).toContain('采集电脑提炼');
    expect(result.manifest.before).toEqual(result.manifest.after);expect(result.manifest.destination).toMatchObject({mode:'new-service-instance',generateNewIdentity:true,reuseWindowsCredentials:false});
    expect(verifyMigrationBundle(output)).toMatchObject({taskCount:1,ledgerEntryCount:2});
    const restored=restoreSafeBackup({backupFile:result.backupFile,dataDirectory:join(f.root,'new-cloud-instance')});expect(restored.identity.generation).toBe(1);
    let repository:Repository|undefined,ledger:LedgerService|undefined,state:RemoteState|undefined;
    try{
      repository=createRepository(join(restored.dataDirectory,'planner.sqlite'),{automaticBackup:()=>{}});ledger=createLedgerService(repository.path);state=new RemoteState(join(restored.dataDirectory,'remote-state.sqlite'));
      const after=repository.snapshot();expect(after.tasks).toEqual(f.planner.entities.task);expect(after.blocks).toEqual(f.planner.entities.block);expect(after.courses).toEqual(f.planner.entities.course);expect(after.goals).toEqual(f.planner.entities.goal);
      expect(after.tasks[0]!.candidateId).toBe(after.candidates[0]!.id);expect(after.tasks[0]!.courseId).toBe(after.courses[0]!.id);expect(after.blocks[0]!.taskId).toBe(after.tasks[0]!.id);expect(after.candidates[0]!.sourceIds).toEqual([after.sources[0]!.id]);
      const money=ledger.exportJson();expect(money.entries.map(entry=>entry.id)).toEqual(f.ledgerBefore.entries.map(entry=>entry.id));expect(money.entries.find(entry=>entry.id==='synthetic-return')!.relatedEntryIds).toEqual(['synthetic-expense']);expect(money.balanceSnapshots[0]!.coveredEntryIds).toEqual(['synthetic-expense','synthetic-return']);expect(money.balanceSnapshots[0]!.balanceCents).toBe(9500);expect(money.entries.every(entry=>entry.originalText==='')).toBe(true);expect(state.devices()).toEqual([]);
    }finally{state?.close();ledger?.close();repository?.close();}
    expect(digest(f.database)).toBe(before);
  });
  it('refuses unconfirmed, relative, live/WAL and nonempty destinations without changing the source',()=>{
    const f=fixture(),before=digest(f.database),target=join(f.root,'refused');
    expect(()=>exportStoppedWindowsCopy({sourceDatabase:f.database,outputDirectory:target,stoppedCopy:false as true})).toThrow(/明确确认/);
    expect(()=>exportStoppedWindowsCopy({sourceDatabase:'planner.sqlite',outputDirectory:target,stoppedCopy:true})).toThrow(/绝对/);
    writeFileSync(f.database+'-wal','synthetic-uncheckpointed-WAL');expect(()=>exportStoppedWindowsCopy({sourceDatabase:f.database,outputDirectory:target,stoppedCopy:true})).toThrow(/边车/);expect(existsSync(target)).toBe(false);expect(digest(f.database)).toBe(before);
    expect(()=>runMigrationCommand(['export','--source-db',f.database,'--output-dir',target])).toThrow(/stopped-copy-confirmed/);
  });
  it('rejects checksum and relationship/count alterations rather than repairing or overwriting inputs',()=>{
    const f=fixture(),output=join(f.root,'bundle');const result=exportStoppedWindowsCopy({sourceDatabase:f.database,outputDirectory:output,stoppedCopy:true});
    expect(()=>exportStoppedWindowsCopy({sourceDatabase:f.database,outputDirectory:output,stoppedCopy:true})).toThrow(/已存在/);
    expect(()=>exportStoppedWindowsCopy({sourceDatabase:f.database,outputDirectory:join(f.source,'inside'),stoppedCopy:true})).toThrow(/分开/);
    const original=readFileSync(result.backupFile);writeFileSync(result.backupFile,Buffer.concat([original,Buffer.from(' ')]));expect(()=>verifyMigrationBundle(output)).toThrow(/SHA256/);writeFileSync(result.backupFile,original);
    const manifest=JSON.parse(readFileSync(result.manifestFile,'utf8'));manifest.after.planner.task+=1;writeFileSync(result.manifestFile,JSON.stringify(manifest));expect(()=>verifyMigrationBundle(output)).toThrow(/核对失败/);
    const unclean=JSON.parse(original.toString('utf8'));unclean.ledger.entries[0].originalText='SYNTHETIC-RAW-REINTRODUCED';const bytes=Buffer.from(JSON.stringify(unclean));writeFileSync(result.backupFile,bytes);
    const matchingManifest=structuredClone(result.manifest);matchingManifest.backup.bytes=bytes.length;matchingManifest.backup.sha256=digest(result.backupFile);writeFileSync(result.manifestFile,JSON.stringify(matchingManifest));expect(()=>verifyMigrationBundle(output)).toThrow(/未清理/);
  });
  it('does not initialize a missing or unsupported source as an empty calendar',()=>{
    const root=mkdtempSync(join(tmpdir(),'calendar-migration-missing-'));roots.push(root);const source=join(root,'source');mkdirSync(source);const path=join(source,'missing.sqlite');
    expect(()=>exportStoppedWindowsCopy({sourceDatabase:path,outputDirectory:join(root,'export'),stoppedCopy:true})).toThrow();expect(existsSync(path)).toBe(false);
    writeFileSync(path,'not-a-database');const old=readFileSync(path);expect(()=>exportStoppedWindowsCopy({sourceDatabase:path,outputDirectory:join(root,'export'),stoppedCopy:true})).toThrow();expect(readFileSync(path)).toEqual(old);expect(existsSync(join(root,'export'))).toBe(false);
  });
});
