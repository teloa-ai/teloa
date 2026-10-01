// 多进程并发回归用子进程：收到 go 后对同一 DSH_HOME 调 resolveStore，结果回传父进程。
// 钥匙串用共享目录模拟；set 时以 wx 建 inflight 标记，建不成说明另一进程同时在 meta 锁临界区里。
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {resolveStore,storePaths} from '../../src/credentials/store-state.ts'
import type {KeyringPort} from '../../src/credentials/key-sources.ts'

const [home,shared]=process.argv.slice(2) as [string,string]
const items=join(shared,'items'),inflight=join(shared,'inflight'),file=(account:string)=>join(items,account.replace(/:/g,'_'))
const port:KeyringPort={
 get:async account=>{
  const value=await readFile(file(account),'utf8').catch(()=>undefined)
  if(await readFile(inflight,'utf8').catch(()=>undefined)===String(process.pid))await rm(inflight,{force:true})
  return value
 },
 set:async(account,value)=>{
  try{await writeFile(inflight,String(process.pid),{flag:'wx'})}catch{await writeFile(join(shared,`overlap-${process.pid}`),'')}
  await new Promise(done=>setTimeout(done,30))
  await mkdir(items,{recursive:true})
  await writeFile(file(account),value)
 },
 delete:async account=>{await rm(file(account),{force:true});return true},
}
process.once('message',async()=>{
 const state=await resolveStore(storePaths(home),'auto',{keyring:port,env:{},keyDir:join(shared,'keys')})
 process.send!(state.mode==='encrypted'?{mode:state.mode,installId:state.meta.installId,keyId:state.meta.keyId}:state,()=>process.exit(0))
})
process.send!('ready')
