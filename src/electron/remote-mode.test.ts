import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { writePrivate } from '../remote/private-file';
import { SnapshotSchema } from '../shared/contracts';

const mock=vi.hoisted(()=>({handlers:new Map<string,(...args:unknown[])=>unknown>(),menu:[] as {label?:string;submenu?:{label?:string;click?:()=>void}[]}[],canEncrypt:true,cleartext:'',client:{pair:vi.fn(),rpc:vi.fn(),close:vi.fn()},journal:{rpc:vi.fn(),inspect:vi.fn(),acknowledge:vi.fn()},createClient:vi.fn(),message:vi.fn(),openImage:vi.fn(),encrypt:vi.fn(),decrypt:vi.fn()}));
vi.mock('electron',async()=>{
  const {EventEmitter}=await import('node:events');
  class Window extends EventEmitter{webContents=Object.assign(new EventEmitter(),{id:1,mainFrame:{routingId:2},send:vi.fn(),setWindowOpenHandler:vi.fn()});isDestroyed(){return false;}isVisible(){return false;}isMinimized(){return false;}loadURL=vi.fn(async()=>{});show=vi.fn();destroy=vi.fn();}
  return{BrowserWindow:Window,Menu:{buildFromTemplate:(value:typeof mock.menu)=>{mock.menu=value;return value;},setApplicationMenu:vi.fn()},app:{isPackaged:true},dialog:{showMessageBox:mock.message,showOpenDialog:mock.openImage},ipcMain:{handle:(name:string,handler:(...args:unknown[])=>unknown)=>mock.handlers.set(name,handler),removeHandler:(name:string)=>mock.handlers.delete(name)},safeStorage:{isEncryptionAvailable:()=>mock.canEncrypt,encryptString:mock.encrypt,decryptString:mock.decrypt},session:{defaultSession:{setPermissionRequestHandler:vi.fn(),setPermissionCheckHandler:vi.fn(),on:vi.fn()}}};
});
vi.mock('../remote/node-client',async importOriginal=>({...await importOriginal<typeof import('../remote/node-client')>(),createNodeRemoteClient:mock.createClient}));
vi.mock('../remote/write-journal',()=>({createWriteJournal:()=>mock.journal}));
import { startNativeRemote } from './remote-mode';

const roots:string[]=[],closers:(()=>void)[]=[];
beforeEach(()=>{mock.handlers.clear();mock.menu=[];mock.canEncrypt=true;vi.clearAllMocks();mock.createClient.mockReturnValue(mock.client);mock.client.pair.mockResolvedValue({});mock.journal.rpc.mockResolvedValue({ok:true,data:SnapshotSchema.parse({schemaVersion:1,sources:[],candidates:[],tasks:[],blocks:[],goals:[],courses:[],courseExceptions:[],preferences:[],feedback:[],settings:{},journal:[],tokenUsage:[],keyStatus:{configured:false,sessionOnly:false}})});mock.journal.inspect.mockResolvedValue({status:'interrupted',requestId:'synthetic-unresolved',method:'mutate'});mock.message.mockResolvedValue({response:0});mock.openImage.mockResolvedValue({canceled:true,filePaths:[]});mock.encrypt.mockImplementation((value:string)=>{mock.cleartext=value;return Buffer.from('synthetic-opaque-cipher');});mock.decrypt.mockImplementation(()=>mock.cleartext);});
afterEach(()=>{for(const close of closers.splice(0))close();for(const root of roots.splice(0)){const part=relative(tmpdir(),root);if(!part||part.startsWith('..')||isAbsolute(part))throw Error('Unsafe test cleanup');rmSync(root,{recursive:true,force:true});}});
function fixture(){const directory=mkdtempSync(join(tmpdir(),'calendar-native-mode-'));roots.push(directory);const code=join(directory,'pairing-code.txt');writePrivate(code,'synthetic-high-entropy-pair-code');return{directory,config:{origin:'https://synthetic.example',deviceName:'合成Windows',pairingCodeFile:code},document:'file:///synthetic/index.html'};}
describe('native cloud-mode boundary',()=>{
  it('fails before pairing or creating a window when OS credential encryption is unavailable',async()=>{const f=fixture();mock.canEncrypt=false;await expect(startNativeRemote(f.config,f.directory,f.document)).rejects.toThrow(/加密不可用/);expect(mock.createClient).not.toHaveBeenCalled();expect(mock.client.pair).not.toHaveBeenCalled();});
  it('uses safeStorage and forwards only the remote whitelist plus explicit image selection',async()=>{
    const f=fixture(),runtime=await startNativeRemote(f.config,f.directory,f.document);closers.push(runtime.close);
    const credentials=mock.createClient.mock.calls[0]![0].credentials;credentials.write({cookie:'synthetic-private-cookie'});expect(mock.encrypt).toHaveBeenCalled();expect(readFileSync(join(f.directory,'credentials','remote-device.bin'),'utf8')).not.toContain('synthetic-private-cookie');expect(credentials.read()).toEqual({cookie:'synthetic-private-cookie'});
    const event={sender:{id:1},senderFrame:{routingId:2,url:f.document}};
    for(const [method,input] of [['backup',undefined],['captureSnapshot',undefined],['setApiKey',{key:'synthetic'}]] as const){const handler=mock.handlers.get('planner:'+method)!;expect(await handler(event,input)).toMatchObject({ok:false,error:{code:'VALIDATION'}});}
    expect(mock.journal.rpc).not.toHaveBeenCalled();expect(await mock.handlers.get('planner:snapshot')!(event,undefined)).toMatchObject({ok:true});expect(mock.journal.rpc).toHaveBeenCalledWith('snapshot',undefined);
    expect(await mock.handlers.get('planner:selectImage')!(event,undefined)).toEqual({ok:true,data:null});expect(mock.openImage).toHaveBeenCalledTimes(1);
  });
  it('keeps the menu recovery guard unless the user explicitly confirms the acknowledgement',async()=>{
    const f=fixture(),runtime=await startNativeRemote(f.config,f.directory,f.document);closers.push(runtime.close);const inspect=mock.menu[0]!.submenu!.find(item=>item.label==='核对云端操作')!.click!;
    inspect();await vi.waitFor(()=>expect(mock.message).toHaveBeenCalledTimes(1));expect(mock.message.mock.calls[0]![1]).toMatchObject({defaultId:0,cancelId:0,buttons:['保留保护','已核对资料，解除保护']});expect(mock.journal.acknowledge).not.toHaveBeenCalled();
    mock.message.mockResolvedValue({response:1});inspect();await vi.waitFor(()=>expect(mock.journal.acknowledge).toHaveBeenCalledWith('synthetic-unresolved'));
  });
});
