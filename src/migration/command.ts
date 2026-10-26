import { exportStoppedWindowsCopy, verifyMigrationBundle } from './export';

export function runMigrationCommand(args:string[]){
  const [command,...flags]=args,values=new Map<string,string>();
  for(let index=0;index<flags.length;index+=2){const key=flags[index],value=flags[index+1];if(!key?.startsWith('--')||!value||value.startsWith('--')||values.has(key))throw Error('参数应为 --名称 值，不能重复');values.set(key,value);}
  if(command==='verify'){
    if(values.size!==1||!values.get('--bundle-dir'))throw Error('verify 只接受 --bundle-dir 绝对目录');
    return verifyMigrationBundle(values.get('--bundle-dir')!);
  }
  if(command!=='export'||values.size!==3||![...values.keys()].every(key=>['--source-db','--output-dir','--stopped-copy-confirmed'].includes(key))||values.get('--stopped-copy-confirmed')!=='yes')throw Error('export 必须指定 --source-db 绝对副本路径 --output-dir 全新绝对目录 --stopped-copy-confirmed yes');
  return exportStoppedWindowsCopy({sourceDatabase:values.get('--source-db')!,outputDirectory:values.get('--output-dir')!,stoppedCopy:true});
}
