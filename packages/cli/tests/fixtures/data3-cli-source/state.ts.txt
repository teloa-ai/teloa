import {mkdir,lstat,readFile,open,rename,unlink,chmod} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {dirname,join} from 'node:path'
import type {InstallState,Layout} from './contracts.ts'
import {resolveLayout,exactVersion} from './layout.ts'
export async function privateDirectory(path:string):Promise<void>{
 await mkdir(path,{recursive:true,mode:0o700})
 const entry=await lstat(path)
 if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('安装目录不是独立目录。')
 await chmod(path,0o700)
}
export async function writePrivateJson(path:string,value:unknown):Promise<void>{
 await privateDirectory(dirname(path))
 const temporary=path+'.'+randomUUID()+'.tmp',handle=await open(temporary,'wx',0o600)
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync()}finally{await handle.close()}
 try{await rename(temporary,path)}catch(error){await unlink(temporary).catch(()=>{});throw error}
}
export async function readPrivateJson(path:string):Promise<unknown>{
 const info=await lstat(path)
 if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw Error('配置文件权限或身份不正确。')
 const content=await readFile(path,'utf8')
 try{return JSON.parse(content)}catch{throw Error('配置文件不是有效的 JSON。')}
}
async function validate(value:any,layout:Layout):Promise<InstallState>{
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='database,id,layout,phase,port,schema,version'||value.schema!=='teloa.install/v1'||!/^[-a-f0-9]{36}$/.test(value.id)||!exactVersion(value.version)||!Number.isInteger(value.port)||value.port<1||value.port>65535||!['prepared','ready','stopped','maintenance','failed'].includes(value.phase))throw Error('安装状态损坏或版本不受支持。')
 const db=value.database
 if(!db||!['docker','existing'].includes(db.kind)||Object.keys(db).sort().join(',')!==(db.kind==='docker'?'kind':'configFile,kind')||db.kind==='existing'&&typeof db.configFile!=='string')throw Error('安装状态中的数据库选择无效。')
 const expected=await resolveLayout({home:layout.home,version:value.version,workspace:value.layout?.workspaceRoot})
 if(Object.keys(expected).some(key=>value.layout?.[key]!==expected[key as keyof Layout])||Object.keys(value.layout).length!==Object.keys(expected).length)throw Error('安装状态目录与当前安装不一致。')
 return value
}
export async function readInstall(layout:Layout):Promise<InstallState|null>{
 try{return await validate(await readPrivateJson(join(layout.instanceRoot,'state.json')),layout)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('安装状态不可读取：'+(error as Error).message)}
}
export async function writeInstall(state:InstallState):Promise<void>{
 await validate(state,state.layout)
 await writePrivateJson(join(state.layout.instanceRoot,'state.json'),state)
}
export async function withInstallLock<T>(home:string,action:()=>Promise<T>):Promise<T>{
 await privateDirectory(home)
 const path=join(home,'install.lock'),identity=randomUUID()
 let handle
 try{handle=await open(path,'wx',0o600)}catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
  // 恢复者另行串行化，避免两个恢复者删掉对方刚取得的新锁。
  let recovery
  try{recovery=await open(path+'.recovery','wx',0o600)}catch{throw Error('另一项安装操作正在进行；请等待完成。')}
  try{
   const old=await readPrivateJson(path) as {pid?:number}
   if(!Number.isInteger(old?.pid)||old.pid!<1)throw Error('安装互斥记录损坏，请检查 install.lock。')
   let running=true
   try{process.kill(old.pid!,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')running=false}
   if(running)throw Error('另一项安装操作正在进行；请等待完成。')
   await unlink(path)
   try{handle=await open(path,'wx',0o600)}catch{throw Error('另一项安装操作正在进行；请等待完成。')}
  }finally{await recovery.close();await unlink(path+'.recovery')}
 }
 await handle.writeFile(JSON.stringify({pid:process.pid,identity}));await handle.close()
 try{return await action()}finally{
  const current=JSON.parse(await readFile(path,'utf8'))
  if(current.identity===identity)await unlink(path)
 }
}
