import {readFile,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {release as osRelease} from 'node:os'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {command} from './process.ts'
import {controlRecord,portAvailable} from './service.ts'
import {readPrivateJson} from './state.ts'
import type {InstallState,ProcessIdentity} from './contracts.ts'
import {verifyRelease} from './releases.ts'

export type MaintenanceProcessIdentity={pid:number;ppid:number;uid:number;birthSec:number;birthUsec:number;uniqueId:string;parentUniqueId:string;pidVersion:number;executable:string;cwd:string;bootId:string;children:number[]}
export type MaintenanceProcessReceipt={schema:'teloa.maintenance-process-exit/v1';bindingSha256:string;platform:'darwin';arch:string;osRelease:string;observationScope:'bound-processes-after-registration';supervisor:MaintenanceProcessIdentity;child:MaintenanceProcessIdentity;referenceMcp?:MaintenanceProcessIdentity;exited:number[];observedAt:string;signal:'SIGTERM'}
export type MaintenanceProcesses={control:ProcessIdentity&{port:number};supervisor:MaintenanceProcessIdentity;child:MaintenanceProcessIdentity;referenceMcp?:MaintenanceProcessIdentity}
const denied=()=>Error('原宿主的身份或退出证据无法核对，维护保持停止；不会向未知进程发送信号。')
const identities=(value:Pick<MaintenanceProcesses,'supervisor'|'child'|'referenceMcp'>)=>[value.supervisor,value.child,...value.referenceMcp?[value.referenceMcp]:[]]
function assertTopology(value:Pick<MaintenanceProcesses,'supervisor'|'child'|'referenceMcp'>):void{
 const {supervisor,child,referenceMcp}=value,all=identities(value)
 if(new Set(all.map(v=>v.pid)).size!==all.length||!isDeepStrictEqual(supervisor.children,[child.pid])||child.ppid!==supervisor.pid||child.parentUniqueId!==supervisor.uniqueId||all.some(v=>v.uid!==supervisor.uid||v.bootId!==supervisor.bootId||v.executable!==supervisor.executable)||!isDeepStrictEqual(child.children,referenceMcp?[referenceMcp.pid]:[])||referenceMcp&&(referenceMcp.ppid!==child.pid||referenceMcp.parentUniqueId!==child.uniqueId||referenceMcp.children.length))throw denied()
}
export const maintenanceDigest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
export async function maintenanceHelper(releaseRoot:string):Promise<string>{
 const root=join(releaseRoot,'packages/cli/libexec'),path=join(root,'maintenance-process'),support=JSON.parse(await readFile(join(root,'support.json'),'utf8'))
 const abi={procPidUniqueIdentifierInfo:17,procUniqueIdentifierInfoSize:56,auditTokenPidIndex:5,auditTokenPidVersionIndex:7}
 if(process.platform!=='darwin'||support.schema!=='teloa.maintenance-process-support/v1'||support.supported!==true||support.platform!==process.platform||support.arch!==process.arch||String(support.osMajor)!==osRelease().split('.')[0]||!isDeepStrictEqual(support.abi,abi))throw Error('当前系统没有经过验证的维护进程证明能力；不会使用普通PID信号代替。')
 const info=await lstat(path)
 if(!info.isFile()||info.isSymbolicLink()||maintenanceDigest(await readFile(path))!==support.binarySha256)throw denied()
 return path
}
export async function inspectMaintenanceProcess(helper:string,pid:number,options:{timeoutMs?:number}={}):Promise<MaintenanceProcessIdentity|null>{
 if(!Number.isSafeInteger(pid)||pid<1)throw denied()
 const result=await command(helper,['inspect',String(pid)],options.timeoutMs===undefined?{}:{timeout:options.timeoutMs})
 let value:any;try{value=JSON.parse(result.stdout)}catch{throw denied()}
 if(result.code===3&&value.absent===true&&value.pid===pid)return null
 if(result.code!==0||value.pid!==pid||!Number.isSafeInteger(value.pidVersion)||value.pidVersion<1||typeof value.uniqueId!=='string'||!/^\d+$/.test(value.uniqueId)||!Array.isArray(value.children)||typeof value.bootId!=='string')throw denied()
 return value
}
export async function captureMaintenanceProcesses(state:InstallState,helper:string):Promise<MaintenanceProcesses>{
 const control=await controlRecord(state);if(!control)throw denied()
 const response=await fetch('http://127.0.0.1:'+control.port+'/status',{method:'POST',headers:{authorization:'Bearer '+control.secret,'content-type':'application/json'},body:JSON.stringify({nonce:control.nonce,installId:state.id}),signal:AbortSignal.timeout(5000)})
 const value=await response.json() as any
 if(!response.ok||value.ok!==true||value.value?.app!=='ready'||!['pid','startedAt','nonce','installId'].every(key=>value[key]===Reflect.get(control,key)))throw denied()
 const supervisor=await inspectMaintenanceProcess(helper,control.pid)
 if(!supervisor||supervisor.uid!==process.getuid?.()||supervisor.children.length!==1||supervisor.cwd!==state.layout.workspaceRoot)throw denied()
 const child=await inspectMaintenanceProcess(helper,supervisor.children[0]!)
 if(!child||child.children.length>1||child.cwd!==state.layout.workspaceRoot)throw denied()
 const referenceMcp=child.children.length?await inspectMaintenanceProcess(helper,child.children[0]!):undefined
 if(referenceMcp===null)throw denied()
 const topology={supervisor,child,...referenceMcp?{referenceMcp}:{}}
 assertTopology(topology)
 const commands:Array<readonly [MaintenanceProcessIdentity,readonly string[]]>=[[supervisor,[join(state.layout.releaseRoot,'packages/cli/lib/service-entry.js'),state.layout.home]],[child,[join(state.layout.releaseRoot,'scripts/runtime/native-runtime-entry.mjs'),'--profile','teloa','--no-open','--host','127.0.0.1','--port',String(state.port)]]]
 if(referenceMcp){
  const manifest=await verifyRelease(state.layout.releaseRoot)
  if(referenceMcp.cwd!==state.layout.releaseRoot||!manifest.files.some(row=>row.path==='packages/mcp-reference/lib/main.js'))throw denied()
  // programRoot 来自官方 service-entry 的 file URL，保留其尾斜线；固定 bundle 再拼接 /packages。
  commands.push([referenceMcp,[state.layout.releaseRoot+'//packages/mcp-reference/lib/main.js']])
 }
 for(const [identity,args] of commands){
  const result=await command('/bin/ps',['-p',String(identity.pid),'-o','args='])
  if(result.code!==0||result.stdout.trim()!==[identity.executable,...args].join(' '))throw denied()
 }
 const {secret:_,...safeControl}=control
 return {control:safeControl,...topology}
}
export function verifyMaintenanceProcessReceipt(receipt:MaintenanceProcessReceipt,expected:MaintenanceProcesses,bindingSha256:string):void{
 assertTopology(expected)
 if(receipt?.schema!=='teloa.maintenance-process-exit/v1'||receipt.bindingSha256!==bindingSha256||receipt.signal!=='SIGTERM'||receipt.platform!=='darwin'||receipt.arch!==process.arch||receipt.observationScope!=='bound-processes-after-registration'||typeof receipt.osRelease!=='string'||!/^\d+\.\d+\.\d+$/.test(receipt.osRelease)||receipt.osRelease.split('.')[0]!==osRelease().split('.')[0]||!Number.isFinite(Date.parse(receipt.observedAt))||!receipt.supervisor||!receipt.child||!isDeepStrictEqual(receipt.supervisor,expected.supervisor)||!isDeepStrictEqual(receipt.child,expected.child)||!isDeepStrictEqual(receipt.referenceMcp,expected.referenceMcp)||!isDeepStrictEqual(receipt.exited,identities(expected).map(v=>v.pid).sort((a,b)=>a-b)))throw denied()
}
export async function assertMaintenanceExited(state:InstallState,helper:string,expected:MaintenanceProcesses,receipt:MaintenanceProcessReceipt,bindingSha256:string):Promise<void>{
 verifyMaintenanceProcessReceipt(receipt,expected,bindingSha256)
 const assertControl=async()=>{
  const current=await controlRecord(state)
  if(current&&['pid','startedAt','nonce','installId','port'].some(key=>Reflect.get(current,key)!==Reflect.get(expected.control,key)))throw denied()
 }
 await assertControl()
 const deadline=Date.now()+1200
 for(const identity of identities(expected)){
  let exited=false
  while(Date.now()<deadline){
   try{
    const observed=await inspectMaintenanceProcess(helper,identity.pid,{timeoutMs:Math.min(400,deadline-Date.now())})
    if(!observed||observed.uniqueId!==identity.uniqueId){exited=true;break}
   }catch{/* 仅重查暂时不可证明；错误、超时及同代存活均不作为退出证据。 */}
   const remaining=deadline-Date.now()
   if(remaining>0)await new Promise(resolve=>setTimeout(resolve,Math.min(80,remaining)))
  }
  if(!exited)throw denied()
 }
 await assertControl()
 await portAvailable(state.port);await portAvailable(expected.control.port)
}
export async function stopForSubmissionMaintenance(helper:string,processes:MaintenanceProcesses,path:string,bindingSha256:string):Promise<MaintenanceProcessReceipt>{
 assertTopology(processes)
 const result=await command(helper,[processes.referenceMcp?'fence-reference':'fence',...identities(processes).flatMap(value=>[String(value.pid),String(value.pidVersion),value.uniqueId]),path,bindingSha256],{timeout:20000})
 if(result.code!==0)throw denied()
 const receipt=await readPrivateJson(path) as MaintenanceProcessReceipt
 verifyMaintenanceProcessReceipt(receipt,processes,bindingSha256);return receipt
}
