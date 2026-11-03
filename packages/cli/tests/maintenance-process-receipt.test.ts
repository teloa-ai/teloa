import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir,release} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import {verifyMaintenanceProcessReceipt,assertMaintenanceExited,type MaintenanceProcesses,type MaintenanceProcessReceipt} from '../src/maintenance-process.ts'
import type {InstallState} from '../src/contracts.ts'

const binding='c'.repeat(64),darwin=process.platform==='darwin'
const expected:MaintenanceProcesses={
 control:{pid:700001,startedAt:'2026-10-25T00:00:00.000Z',nonce:'fixture',installId:'fixture',port:1},
 supervisor:{pid:700001,ppid:1,uid:501,birthSec:1792886400,birthUsec:10,uniqueId:'1001',parentUniqueId:'1',pidVersion:3,executable:'/fixture/node',cwd:'/fixture/work',bootId:'fixture-boot',children:[700002]},
 child:{pid:700002,ppid:700001,uid:501,birthSec:1792886401,birthUsec:20,uniqueId:'1002',parentUniqueId:'1001',pidVersion:4,executable:'/fixture/node',cwd:'/fixture/work',bootId:'fixture-boot',children:[]},
}
const receipt=():MaintenanceProcessReceipt=>({schema:'teloa.maintenance-process-exit/v1',bindingSha256:binding,platform:'darwin',arch:process.arch,osRelease:release(),observationScope:'bound-processes-after-registration',supervisor:structuredClone(expected.supervisor),child:structuredClone(expected.child),exited:[700001,700002],observedAt:'2026-10-25T00:01:00.000Z',signal:'SIGTERM'})

test('收据校验拒绝缺失、无效与不同 major 的 OS 证据',{skip:!darwin},()=>{
 assert.doesNotThrow(()=>verifyMaintenanceProcessReceipt(receipt(),expected,binding))
 for(const osRelease of [undefined,'','25.5.0-extra',`${Number(release().split('.')[0])+1}.0.0`]){
  const changed={...receipt(),osRelease} as MaintenanceProcessReceipt
  assert.throws(()=>verifyMaintenanceProcessReceipt(changed,expected,binding))
 }
})
test('收据校验保留完整父子身份和拓扑',{skip:!darwin},()=>{
 for(const change of [
  (value:MaintenanceProcessReceipt)=>{value.child.ppid=1},
  (value:MaintenanceProcessReceipt)=>{value.child.parentUniqueId='9'},
  (value:MaintenanceProcessReceipt)=>{value.child.children=[700003]},
  (value:MaintenanceProcessReceipt)=>{value.supervisor.children=[]},
  (value:MaintenanceProcessReceipt)=>{value.supervisor.ppid=2},
 ]){const value=receipt();change(value);assert.throws(()=>verifyMaintenanceProcessReceipt(value,expected,binding))}
})

test('同发行参考MCP三世代必须完整匹配，缺失退出、额外后代或错身份均拒绝',{skip:!darwin},()=>{
 const processes:MaintenanceProcesses=structuredClone(expected)
 processes.child.children=[700003]
 processes.referenceMcp={...structuredClone(processes.child),pid:700003,ppid:700002,uniqueId:'1003',parentUniqueId:'1002',pidVersion:5,cwd:'/fixture/release',children:[]}
 const value:MaintenanceProcessReceipt={...receipt(),child:structuredClone(processes.child),referenceMcp:structuredClone(processes.referenceMcp),exited:[700001,700002,700003]}
 assert.doesNotThrow(()=>verifyMaintenanceProcessReceipt(value,processes,binding))
 for(const change of [
  (r:MaintenanceProcessReceipt)=>{r.exited=[700001,700002]},
  (r:MaintenanceProcessReceipt)=>{delete r.referenceMcp},
  (r:MaintenanceProcessReceipt)=>{r.referenceMcp!.pidVersion++},
  (r:MaintenanceProcessReceipt)=>{r.referenceMcp!.uniqueId='other'},
 ]){const changed=structuredClone(value);change(changed);assert.throws(()=>verifyMaintenanceProcessReceipt(changed,processes,binding))}
 for(const change of [
  (p:MaintenanceProcesses)=>{p.referenceMcp!.children=[700004]},
  (p:MaintenanceProcesses)=>{p.child.children=[700003,700004]},
  (p:MaintenanceProcesses)=>{p.referenceMcp!.ppid=1},
  (p:MaintenanceProcesses)=>{p.referenceMcp!.parentUniqueId='1'},
  (p:MaintenanceProcesses)=>{p.referenceMcp!.uid++},
  (p:MaintenanceProcesses)=>{p.referenceMcp!.executable='/other/node'},
 ]){const changed=structuredClone(processes);change(changed);assert.ok(changed.referenceMcp);const matching={...value,supervisor:changed.supervisor,child:changed.child,referenceMcp:changed.referenceMcp};assert.throws(()=>verifyMaintenanceProcessReceipt(matching,changed,binding))}
})

async function unusedPort():Promise<number>{
 const server=createServer()
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const port=(server.address() as {port:number}).port
 await new Promise<void>(resolve=>server.close(()=>resolve()))
 return port
}
async function fixture(mode:string,run:(value:{state:InstallState;helper:string;processes:MaintenanceProcesses})=>Promise<void>,withReference=false){
 const root=await mkdtemp(join(tmpdir(),'teloa-maintenance-receipt-')),helper=join(root,'helper'),counter=join(root,'counter')
 const processes=structuredClone(expected);processes.control.port=await unusedPort()
 if(withReference){processes.child.children=[700003];processes.referenceMcp={...structuredClone(processes.child),pid:700003,ppid:700002,uniqueId:'1003',parentUniqueId:'1002',pidVersion:5,cwd:'/fixture/release',children:[]}}
 const state:InstallState={schema:'teloa.install/v1',id:'fixture',version:'0.2.12',phase:'maintenance',database:{kind:'docker'},port:await unusedPort(),layout:{home:root,releaseRoot:root,instanceRoot:root,dshHome:root,runtimeRoot:root,workspaceRoot:root}}
 // 模拟外部 helper 的真实退出码/输出边界；不接触任意真实 PID 或用户安装。
 // shell 夹具避免把另一个 Node 的冷启动时间混入 400ms 原生查询预算。
 const identityJson=(value:MaintenanceProcesses['supervisor'])=>JSON.stringify(mode==='new-generation'?{...value,uniqueId:'2000'+value.pid,pidVersion:value.pidVersion+1}:value)
 const source=`#!/bin/sh
count=0
if [ -f '${counter}' ]; then read count < '${counter}'; fi
printf '%s\\n' "$((count + 1))" > '${counter}'
case '${mode}' in
 hang) exec /bin/sleep 30;;
 permanent-error) exit 1;;
 transient-error) if [ "$count" -eq 0 ]; then exit 1; fi;;
esac
if [ '${mode}' = reference-alive ] && [ "$2" = 700003 ]; then
 printf '%s\\n' '${JSON.stringify(processes.referenceMcp)}'
 exit 0
fi
if [ '${mode}' = same-generation ] || [ '${mode}' = new-generation ] || { [ '${mode}' = transient-same ] && [ "$count" -eq 0 ]; }; then
 if [ "$2" = 700001 ]; then printf '%s\\n' '${identityJson(expected.supervisor)}'; else printf '%s\\n' '${identityJson(expected.child)}'; fi
else
 printf '{"absent":true,"pid":%s}\\n' "$2"
 exit 3
fi
`
 try{await writeFile(helper,source,{mode:0o700});await run({state,helper,processes})}
 finally{await rm(root,{recursive:true,force:true})}
}
for(const mode of ['transient-error','transient-same','new-generation'])test('瞬时退出核验 '+mode+' 必须最终明确不存在或新代',{skip:!darwin,timeout:5000},async()=>{
 await fixture(mode,async({state,helper,processes})=>{await assertMaintenanceExited(state,helper,processes,receipt(),binding)})
})
for(const mode of ['permanent-error','same-generation','hang'])test('持续不可证明 '+mode+' 在短时限内拒绝',{skip:!darwin,timeout:5000},async()=>{
 await fixture(mode,async({state,helper,processes})=>{
  const start=Date.now()
  await assert.rejects(assertMaintenanceExited(state,helper,processes,receipt(),binding))
  assert.ok(Date.now()-start<2000,'退出重查必须有界，不能等待默认30秒')
 })
})
for(const mode of ['reference-alive','all-absent'])test('三世代退出重查 '+mode+' 不能只核对原父子',{skip:!darwin,timeout:5000},async()=>{
 await fixture(mode,async({state,helper,processes})=>{
  assert.ok(processes.referenceMcp)
  const proof={...receipt(),child:processes.child,referenceMcp:processes.referenceMcp,exited:[700001,700002,700003]}
  if(mode==='reference-alive')await assert.rejects(assertMaintenanceExited(state,helper,processes,proof,binding))
  else await assertMaintenanceExited(state,helper,processes,proof,binding)
 },true)
})
