import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {setImmediate} from 'node:timers/promises'
import ts from 'typescript'
import * as contract from '@teloa/contract'
import {canReceiveTask} from '../src/client/role-preview.ts'
import {createRoleWorkDirectory} from '../src/client/role-work-directory.ts'
import {homeWorkAssigneeOptions,resolveHomeWorkAssignee} from '../src/client/home-work-assignee.ts'
import {persistentBusinessTaskAssignees} from '../src/client/business-task-presentation.ts'
import {activeHandoffCandidates} from '../src/client/task-handoff-presentation.ts'

const employeeId='11111111-1111-4111-8111-111111111111',twinId='22222222-2222-4222-8222-222222222222',delegationId='33333333-3333-4333-8333-333333333333',consentId='44444444-4444-4444-8444-444444444444'
const employee={id:employeeId,kind:'employee',state:'active',version:2,name:'同事',scopes:['sales'],duty:'核验',dataScope:'获准订单',executionScope:'只读',skills:[],knowledge:[]}
const twin={...employee,id:twinId,kind:'twin',name:'我的分身'}
const delegation={id:delegationId,ownerId:'owner',roleId:twinId,roleVersion:2,version:1,state:'active',scope:'sales',allowedTools:['read'],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false,createdAt:'2026-10-09T00:00:00.000Z',updatedAt:'2026-10-09T00:00:00.000Z'}
const consent={schema:'teloa.twin-execution-consent/v1',id:consentId,ownerId:'owner',roleId:twinId,roleVersion:2,version:1,state:'active',authorization:{kind:'delegation',delegationId,delegationVersion:1},createdAt:'2026-10-09T00:00:00.000Z'}
const access={roleId:twinId,roleVersion:2,delegations:[delegation],consents:[consent],canEditExecution:false}
const rows=async(read:unknown=access)=>createRoleWorkDirectory({list:async()=>[employee,twin]} as any,{get:async()=>{if(read instanceof Error)throw read;return read}} as any).list()
function mount(file:string){
 const states:any[]=[],effects:(()=>unknown)[]=[];let cursor=0
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),useMemo:(factory:()=>unknown,deps:unknown[])=>{const index=cursor++;if(!states[index]||deps.some((value,offset)=>value!==states[index].deps[offset]))states[index]={deps,value:factory()};return states[index].value},useId:()=> 'hint',useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},useState:(value:unknown)=>{const index=cursor++;if(!(index in states))states[index]=value;return [states[index],(next:any)=>states[index]=typeof next==='function'?next(states[index]):next]},useEffect:(effect:()=>unknown)=>effects.push(effect)}
 const modules:Record<string,unknown>={react:React,'@teloa/contract':contract,'./role-preview.js':{canReceiveTask},'./i18n/provider.js':{useI18n:()=>({t:(key:string)=>key})},'./i18n/locales/business-reassignment.ts':{BUSINESS_REASSIGNMENT_MESSAGES:{zh:new Proxy({},{get:(_target,key)=>String(key)}),en:{}}}}
 const source=readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,exports:Record<string,any>={}
 new Function('require','exports','React',code)((id:string)=>modules[id]??(id.endsWith('.css')?{default:{}}:id.includes('business-reassignment.ts')?contract:id.includes('business-reassignment-api')?{verifyBusinessReassignmentReceipt:()=>undefined}:id.includes('business-reassignment')?{BUSINESS_REASSIGNMENT_MESSAGES:{zh:new Proxy({},{get:(_target,key)=>String(key)}),en:{}}}:{}),exports,React)
 return {effects,render:(props:any)=>{cursor=0;effects.length=0;return exports[file.replace('.tsx','')](props)}}
}
const nodes=(node:any):any[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
const options=(node:any)=>nodes(node).filter(value=>value.type==='option').map(value=>value.props.value)

test('业务角色目录只附当前真实委托；未知/跨身份/旧版本不给分身许可，员工原入口保留',async()=>{
 const granted=await rows();assert.equal(canReceiveTask(granted[1] as any,'sales'),true);assert.deepEqual(granted[0],employee)
 for(const value of [new Error('服务未知'),{...access,roleVersion:1},{...access,roleId:employeeId},{...access,consents:[]}]){
  const directory=await rows(value)
  assert.equal(canReceiveTask(directory[0] as any,'sales'),true)
  assert.equal(canReceiveTask(directory[1] as any,'sales'),false)
 }
})

test('负责人选择仅允许已获委托分身，保存仍只写角色归属，不创建Run或本人许可',async()=>{
 const page=mount('BusinessResponsibility.tsx'),writes:unknown[]=[],current={scope:'sales',version:0,roleId:null,selectedRoleVersion:null,currentRoleVersion:null,availability:'none'}
 const props={scope:'sales',roles:{list:()=>rows()},api:{pending:()=>null,reconcile:async()=>current,set:async(value:unknown)=>writes.push(value),read:async()=>({...current,version:1,roleId:twinId})}}
 page.render(props);page.effects[0]!();await setImmediate()
 let view=page.render(props);assert.ok(options(view).includes(twinId))
 nodes(view).find(node=>node.type==='select').props.onChange({target:{value:twinId}})
 view=page.render(props);nodes(view).find(node=>node.type==='button'&&node.children.includes('business.responsibility.save')).props.onClick();await setImmediate()
 assert.equal(writes.length,1);assert.deepEqual((writes[0] as any).role,{id:twinId,expectedVersion:2});assert.deepEqual(Object.keys(writes[0] as object).sort(),['expectedVersion','requestId','role','scope'])
 for(const value of [{...access,consents:[]},{...access,delegations:[{...delegation,state:'paused'}]},new Error('读取未知')]){
  const denied=mount('BusinessResponsibility.tsx'),input={...props,roles:{list:()=>rows(value)}}
  denied.render(input);denied.effects[0]!();await setImmediate();const deniedView=denied.render(input)
  assert.ok(options(deniedView).includes(employeeId));assert.ok(!options(deniedView).includes(twinId))
 }
})

test('改派输入准备继承可信分身资格；撤销后保留原稿，不发送旧选择',async()=>{
 const page=mount('BusinessReassignment.tsx'),prepared:unknown[]=[],props={locale:'zh-CN',scope:'sales',sessionId:'daily',context:{scope:'sales',sessionId:'daily',version:1,roleId:null},originals:[{oldRequestId:employeeId,oldRoleId:employeeId,oldSessionId:'daily',scope:'sales',title:'原交办',stopSubmitted:false}],roles:await rows(),onPrepare:async(value:unknown)=>{prepared.push(value)},onNewDaily:async()=>{throw Error('不得自动建会话')}}
 let view=page.render(props);assert.ok(options(view).includes(twinId))
 nodes(view).filter(node=>node.type==='select')[1].props.onChange({target:{value:twinId}})
 view=page.render(props);nodes(view).find(node=>node.type==='button'&&node.children.includes('prepare')).props.onClick();await setImmediate()
 assert.equal(prepared.length,1);assert.equal((prepared[0] as any).newRoleId,twinId);assert.equal(Object.hasOwn(prepared[0] as object,'authorization'),false)
 view=page.render({...props,roles:await rows({...access,consents:[{...consent,state:'revoked'}]})})
 assert.ok(!options(view).includes(twinId));const button=nodes(view).find(node=>node.type==='button'&&node.children.includes('prepare'));assert.equal(button.props.disabled,true);button.props.onClick();await setImmediate();assert.equal(prepared.length,1)
})

test('首页、业务任务和交接从真实目录读取同一分身资格，范围变更与未知许可均拒绝',async()=>{
 const previews=(directory:unknown[])=>directory.map((role:any)=>({...role,storage:'persistent',memories:[],history:[]}))
 const candidates=(directory:unknown[],scope='sales')=>{
  const roles=previews(directory),home=homeWorkAssigneeOptions(roles),task={scope,assigneeId:employeeId} as any
  return {home:home.filter(option=>{try{return !!resolveHomeWorkAssignee(home,option.id,scope as any)}catch{return false}}).map(role=>role.id),business:persistentBusinessTaskAssignees(roles,scope).map(role=>role.id),handoff:activeHandoffCandidates(task,roles).filter(row=>row.kind==='role').map(row=>row.id)}
 }
 assert.deepEqual(candidates(await rows()),{home:[employeeId,twinId],business:[employeeId,twinId],handoff:[twinId]})
 for(const unavailable of [new Error('委托读取未知'),{...access,roleVersion:1},{...access,consents:[]},{...access,consents:[{...consent,state:'revoked'}]}])assert.deepEqual(candidates(await rows(unavailable)),{home:[employeeId],business:[employeeId],handoff:[]})
 assert.deepEqual(candidates(await rows(),'general'),{home:[employeeId],business:[employeeId],handoff:[]})
 const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8')
 assert.match(source,/const roleWorkDirectory=createRoleWorkDirectory\(roleApi,roleDelegationApi\)/)
 const start=source.indexOf("id:'teloa-work-context'"),port=source.slice(start,source.indexOf('},HomeComposerContext)',start))
 assert.match(port,/roleWorkDirectory\.list\(\)/);assert.doesNotMatch(port,/roleApi\.list\(\)|kind==='employee'/)
})
