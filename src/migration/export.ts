import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { openDatabase } from '../storage/database';
import { kinds, parseState, readDatabaseState, type StoredState } from '../storage/repository';
import { readLedgerDatabase, validateLedgerData } from '../ledger/service';
import { LedgerImportPayloadSchema, type LedgerData } from '../shared/ledger';
import { validateSafeBackup } from '../server/backup';

const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function fileDigest(path:string){const hash=createHash('sha256'),fd=openSync(path,'r'),chunk=Buffer.allocUnsafe(1024*1024);try{let length:number;while((length=readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,length));return hash.digest('hex');}finally{closeSync(fd);}}
const Digest=z.string().regex(/^[a-f0-9]{64}$/);
const Counts=z.strictObject({ planner:z.record(z.enum(kinds as [typeof kinds[number],...typeof kinds[number][]]),z.number().int().nonnegative()), ledger:z.strictObject({entries:z.number().int().nonnegative(),balanceSnapshots:z.number().int().nonnegative(),audit:z.number().int().nonnegative(),sources:z.number().int().nonnegative()}) });
export const MigrationManifestSchema=z.strictObject({
  format:z.literal('ultimate-calendar-offline-migration'),formatVersion:z.literal(1),createdAt:z.string().datetime(),
  destination:z.strictObject({mode:z.literal('new-service-instance'),requireEmptyDirectory:z.literal(true),generateNewIdentity:z.literal(true),reuseWindowsCredentials:z.literal(false),replayTransportReceipts:z.literal(false)}),
  source:z.strictObject({kind:z.literal('explicit-stopped-sqlite-copy'),sha256:Digest,bytes:z.number().int().positive(),userVersion:z.literal(1)}),
  backup:z.strictObject({filename:z.literal('safe-backup.json'),sha256:Digest,bytes:z.number().int().positive()}),
  before:Counts,after:Counts,relationshipsSha256:Digest,
  privacy:z.strictObject({sourcePayloads:z.literal('removed'),qqComputerIdentifiers:z.literal('removed'),ledgerOriginalText:z.literal('removed'),credentialsAndSessions:z.literal('excluded')}),
});
export type MigrationManifest=z.infer<typeof MigrationManifestSchema>;
function within(parent:string,child:string){const value=relative(parent,child);return !value||value!=='..'&&!value.startsWith('..'+sep)&&!isAbsolute(value);}
function plainFile(path:string){const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('输入必须是独立的普通文件副本，不能是链接');return info;}
function rejectSidecars(path:string){for(const suffix of ['-wal','-shm','-journal'])if(existsSync(path+suffix))throw Error('副本仍有 WAL/SHM/journal 边车；请先停止应用并生成完整一致的独立副本，未读取资料');}
function counts(planner:StoredState,ledger:LedgerData){return{planner:Object.fromEntries(kinds.map(kind=>[kind,planner.entities[kind].length])),ledger:{entries:ledger.entries.length,balanceSnapshots:ledger.balanceSnapshots.length,audit:ledger.audit.length,sources:ledger.sources.length}};}
function relationships(planner:StoredState,ledger:LedgerData){
  const result:unknown[]=[];
  for(const task of planner.entities.task)result.push(['task',task.id,Reflect.get(task,'goalId'),Reflect.get(task,'courseId'),Reflect.get(task,'candidateId')]);
  for(const block of planner.entities.block)result.push(['block',block.id,Reflect.get(block,'taskId'),Reflect.get(block,'recurrence')]);
  for(const candidate of planner.entities.candidate)result.push(['candidate',candidate.id,Reflect.get(candidate,'sourceIds'),Reflect.get(candidate,'revisionOfId'),Reflect.get(candidate,'duplicateOfId')]);
  for(const exception of planner.entities.courseException)result.push(['courseException',exception.id,Reflect.get(exception,'courseId')]);
  for(const entry of ledger.entries)result.push(['entry',entry.id,entry.sourceId,entry.relatedEntryIds,entry.adjustments,entry.cashflows,entry.snapshotPositions]);
  for(const snapshot of ledger.balanceSnapshots)result.push(['balanceSnapshot',snapshot.id,snapshot.sourceId,snapshot.coveredEntryIds]);
  for(const audit of ledger.audit)result.push(['audit',audit.id,audit.entryIds,audit.beforeEntries.map(entry=>entry.id)]);
  return sha256(JSON.stringify(result));
}
/** Only known raw evidence fields are removed; formal records, amounts, IDs, links and audit structure remain. */
function removeMigrationEvidence(value:unknown):unknown{
  if(Array.isArray(value))return value.map(removeMigrationEvidence);
  if(!value||typeof value!=='object')return value;
  const original=value as Record<string,unknown>;
  const result=Object.fromEntries(Object.entries(original).filter(([key])=>key!=='captureRef').map(([key,item])=>[key,removeMigrationEvidence(item)]));
  if('originalText' in original)result.originalText='';
  if('imageDataUrl' in original&&'importedAt' in original&&['text','image'].includes(String(original.kind))&&original.captureRef)result.label='采集电脑提炼';
  return result;
}
function readStoppedCopy(path:string,workspaceParent:string){
  const file=plainFile(path);rejectSidecars(path);const fingerprint=fileDigest(path);
  // SQLite can create -wal/-shm beside a WAL-mode database even with readOnly:true.
  // Therefore only an owned working duplicate is opened; SQLite never sees the source path.
  const work=mkdtempSync(join(workspaceParent,'.calendar-migration-read-')),verifiedWork=realpathSync(work),workingFile=join(work,'planner.sqlite');
  let planner:StoredState,ledger:LedgerData;
  try{
    copyFileSync(path,workingFile);
    if(fileDigest(workingFile)!==fingerprint)throw Error('工作副本与源文件 SHA256 不一致，未导出');
    const db=openDatabase(workingFile,true);
    try{
      if(db.prepare('PRAGMA user_version').get()!['user_version']!==1)throw Error('不支持的资料副本版本；未初始化或迁移源文件');
      db.exec('BEGIN');
      try{
        if(db.prepare('PRAGMA integrity_check').get()!['integrity_check']!=='ok')throw Error('资料副本完整性检查失败');
        planner=readDatabaseState(db);ledger=readLedgerDatabase(db);validateLedgerData(ledger);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }finally{db.close();}
  }finally{
    const actual=realpathSync(work);if(actual!==verifiedWork||dirname(actual)!==workspaceParent||!/^\.calendar-migration-read-[A-Za-z0-9]+$/.test(basename(actual)))throw Error('迁移工作目录身份改变，未自动清理');
    rmSync(actual,{recursive:true,force:true});
  }
  rejectSidecars(path);const after=plainFile(path);
  if(file.dev!==after.dev||file.ino!==after.ino||file.size!==after.size||fileDigest(path)!==fingerprint)throw Error('读取期间源副本改变；已停止，未输出迁移文件');
  return{planner,ledger,source:{kind:'explicit-stopped-sqlite-copy' as const,sha256:fingerprint,bytes:file.size,userVersion:1 as const}};
}

/** No production-path default, writes to the input, upload, credential import or destination restore. */
export function exportStoppedWindowsCopy(options:{sourceDatabase:string;outputDirectory:string;stoppedCopy:true;now?:Date}){
  if(options.stoppedCopy!==true)throw Error('必须明确确认输入是已停止应用的一致副本');
  if(!isAbsolute(options.sourceDatabase)||!isAbsolute(options.outputDirectory))throw Error('来源副本与输出目录必须显式指定绝对路径');
  const sourcePath=realpathSync(options.sourceDatabase),sourceDirectory=dirname(sourcePath);
  plainFile(options.sourceDatabase);
  const requested=resolve(options.outputDirectory),parent=realpathSync(dirname(requested)),target=join(parent,basename(requested));
  if(within(sourceDirectory,target)||within(target,sourceDirectory))throw Error('输出目录必须与源副本目录分开，不能放入源目录或覆盖其上级');
  if(existsSync(target))throw Error('迁移输出目录已存在；不会覆盖或清理任何已有文件');
  const input=readStoppedCopy(sourcePath,parent),now=options.now??new Date();
  const {revision:_revision,...ledgerFields}=input.ledger;
  const candidate={format:'ultimate-calendar-safe-backup',formatVersion:1,createdAt:now.toISOString(),planner:removeMigrationEvidence(input.planner),ledger:removeMigrationEvidence({format:'ultimate-calendar-ledger',formatVersion:1,...ledgerFields})};
  const validated=validateSafeBackup(candidate);
  const {revision:_validatedRevision,...validatedLedger}=validated.ledger;
  const envelope={format:'ultimate-calendar-safe-backup',formatVersion:1,createdAt:now.toISOString(),planner:parseState(validated.planner),ledger:LedgerImportPayloadSchema.parse({format:'ultimate-calendar-ledger',formatVersion:1,...validatedLedger})};
  const before=counts(input.planner,input.ledger),after=counts(validated.planner,validated.ledger),links=relationships(input.planner,input.ledger);
  if(JSON.stringify(before)!==JSON.stringify(after)||relationships(validated.planner,validated.ledger)!==links)throw Error('脱敏前后记录数量或正式关联不一致；未导出');
  const bytes=Buffer.from(JSON.stringify(envelope));
  const manifest=MigrationManifestSchema.parse({format:'ultimate-calendar-offline-migration',formatVersion:1,createdAt:now.toISOString(),destination:{mode:'new-service-instance',requireEmptyDirectory:true,generateNewIdentity:true,reuseWindowsCredentials:false,replayTransportReceipts:false},source:input.source,backup:{filename:'safe-backup.json',sha256:sha256(bytes),bytes:bytes.length},before,after,relationshipsSha256:links,privacy:{sourcePayloads:'removed',qqComputerIdentifiers:'removed',ledgerOriginalText:'removed',credentialsAndSessions:'excluded'}});
  const stage=mkdtempSync(join(parent,'.calendar-migration-')),stagePath=realpathSync(stage);let published=false;
  try{
    writeFileSync(join(stage,'safe-backup.json'),bytes,{flag:'wx',mode:0o600,flush:true});
    writeFileSync(join(stage,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600,flush:true});
    verifyMigrationBundle(stage);
    if(existsSync(target))throw Error('输出目标在导出期间被创建，未覆盖');
    renameSync(stage,target);published=true;
    return{directory:target,backupFile:join(target,'safe-backup.json'),manifestFile:join(target,'manifest.json'),manifest};
  }finally{
    if(!published&&existsSync(stage)){
      const actual=realpathSync(stage);if(actual!==stagePath||dirname(actual)!==parent||!/^\.calendar-migration-[A-Za-z0-9]+$/.test(basename(actual)))throw Error('临时导出目录身份变化，未自动清理');
      rmSync(actual,{recursive:true,force:true});
    }
  }
}

/** Read-only validation. A manifest hash detects alteration; it is not a signature or upload authorization. */
export function verifyMigrationBundle(directory:string){
  if(!isAbsolute(directory))throw Error('核验目录必须为绝对路径');
  const root=realpathSync(directory),manifestFile=join(root,'manifest.json'),backupFile=join(root,'safe-backup.json');
  plainFile(manifestFile);plainFile(backupFile);
  const manifest=MigrationManifestSchema.parse(JSON.parse(readFileSync(manifestFile,'utf8'))),bytes=readFileSync(backupFile);
  if(manifest.backup.bytes!==bytes.length||manifest.backup.sha256!==sha256(bytes))throw Error('备份文件大小或 SHA256 与 manifest 不一致');
  const raw=JSON.parse(bytes.toString('utf8')) as {planner:unknown;ledger:unknown};
  const payload=validateSafeBackup(raw),actual=counts(payload.planner,payload.ledger);
  const {revision:_revision,...ledger}=payload.ledger;
  if(JSON.stringify(raw.planner)!==JSON.stringify(payload.planner)||JSON.stringify(raw.ledger)!==JSON.stringify({format:'ultimate-calendar-ledger',formatVersion:1,...ledger})||JSON.stringify(removeMigrationEvidence(raw))!==JSON.stringify(raw))throw Error('迁移包含未清理的来源、图片或原始记账文本，不能当作已脱敏导出');
  if(JSON.stringify(manifest.before)!==JSON.stringify(manifest.after)||JSON.stringify(actual)!==JSON.stringify(manifest.after)||relationships(payload.planner,payload.ledger)!==manifest.relationshipsSha256)throw Error('manifest 记录数量或正式关联摘要核对失败');
  return{manifest,taskCount:payload.planner.entities.task.length,ledgerEntryCount:payload.ledger.entries.length};
}
