import {randomUUID} from 'node:crypto'
import {appendFile,chmod,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {WorkError} from '@teloa/contract'

// 目录 0o700、文件 0o600、临时文件 + rename 原子替换，同 packages/harness-dsh/src/managed-mcp-connections.ts 的 writeAtomic。
async function writeAtomic(path:string,text:string):Promise<void>{
 await mkdir(dirname(path),{recursive:true,mode:0o700})
 const temp=`${path}.${process.pid}.${randomUUID()}.tmp`
 try{await writeFile(temp,text,{encoding:'utf8',mode:0o600});await chmod(temp,0o600);await rename(temp,path)}
 catch(error){await unlink(temp).catch(()=>{});throw error}
}

/**
 * 单文件 JSON 存储：读、写、update 在同一实例内串行执行；文件不存在读作 empty；
 * JSON 损坏或 parse 拒绝一律 WorkError('teloa/storage-corrupt')，不静默回退为空。
 */
export function createJsonStore<T>(path:string,parse:(v:unknown)=>T,empty:T):{read():Promise<T>;write(next:T):Promise<void>;update(fn:(cur:T)=>T|Promise<T>):Promise<T>}{
 let tail:Promise<unknown>=Promise.resolve()
 const serial=<R>(run:()=>Promise<R>):Promise<R>=>{
  const result=tail.then(run,run)
  tail=result.catch(()=>{})
  return result
 }
 const readNow=async():Promise<T>=>{
  let text:string
  try{text=await readFile(path,'utf8')}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return empty;throw error}
  try{return parse(JSON.parse(text))}
  catch{throw new WorkError('teloa/storage-corrupt','IM 通道存储文件已损坏。')}
 }
 const writeNow=(next:T)=>writeAtomic(path,`${JSON.stringify(next,null,2)}\n`)
 return {
  read:()=>serial(readNow),
  write:next=>serial(()=>writeNow(next)),
  update:fn=>serial(async()=>{const next=await fn(await readNow());await writeNow(next);return next}),
 }
}

/** 追加一行 JSON（审计等只增日志）；目录 0o700、文件 0o600。 */
export async function appendJsonl(path:string,row:Record<string,unknown>):Promise<void>{
 await mkdir(dirname(path),{recursive:true,mode:0o700})
 await appendFile(path,`${JSON.stringify(row)}\n`,{encoding:'utf8',mode:0o600})
}
