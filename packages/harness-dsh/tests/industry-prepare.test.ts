import test from 'node:test'
import type {IndustryModelDependency,IndustryModelProbe} from '@teloa/contract'
import assert from 'node:assert/strict'
import {createIndustryPrepareHandler,prepareRequestId,type IndustryPreparePorts} from '../src/industry-prepare.ts'

const owner='local:teloa-owner',loadId='77777777-7777-4777-8777-777777777777',otherLoad='78888888-7777-4777-8777-777777777777'
const K='11111111-1111-4111-8111-111111111111',S1='22222222-2222-4222-8222-222222222222',S2='23333333-2222-4222-8222-222222222222',S3='24444444-2222-4222-8222-222222222222',M='44444444-4444-4444-8444-444444444444'
const R='55555555-5555-4555-8555-555555555555',T='66666666-6666-4666-8666-666666666666',P='88888888-8888-4888-8888-888888888888',G='99999999-9999-4999-8999-999999999999',D='12121212-1212-4121-8121-121212121212'
const ROLE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',INST='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const mutating=new Set(['industry-knowledge/instantiate','skill-installations/install','industry-mcp-connections/instantiate','industry-roles/instantiate','roles/lifecycle'])
const hex=(c:string)=>c.repeat(64)
// 真实形状：公共技能安装的 source 属于首次安装它的加载（industry-public），本加载只经 usages 映射过去（skill-installations.ts:12、:25）
const publicSource={kind:'industry-public',contentId:'c0000000-0000-4000-8000-000000000000',contentHash:hex('e'),resourceId:'alert-triage',resourceVersion:'1.0.0',loadId:otherLoad,itemInstanceId:'c1111111-0000-4000-8000-000000000000',sourceContentId:'c2222222-0000-4000-8000-000000000000',sourceContentHash:hex('f'),sourceResourceId:'alert-triage',sourceResourceVersion:'1.0.0'}
const files=(...paths:string[])=>paths.map(path=>({path,hash:hex('1'),size:10}))

type Options={models?:IndustryModelProbe;dependencies?:Record<string,IndustryModelDependency[]>;roleFails?:boolean;knowledgeSlow?:boolean;unloaded?:boolean;rolePaused?:boolean;roleNeedsConnector?:boolean;tolerant?:boolean;hold?:boolean;connectorDetached?:boolean;s1Files?:string[];s1Trust?:Record<string,unknown>|null;s1TrustHash?:string;s1Bundle?:string;audit?:unknown[];usageOrphan?:boolean;observeState?:string;failLoadsAt?:number}
function world(options:Options={}){
 const calls:[string,any][]=[]
 let release=()=>{},resting=()=>{}
 const held=new Promise<void>(resolve=>{release=resolve}),sleeping=new Promise<void>(resolve=>{resting=resolve})
 type RoleState={state:string;revision:number;role:{id:string;version:number;state:string}|null;failure?:unknown}
 const state={knowledge:undefined as undefined|{state:string;revision:number},kTicks:0,skill:false,mcp:undefined as string|undefined,role:(options.rolePaused?{state:'paused',revision:1,role:{id:ROLE,version:3,state:'paused'}}:undefined) as RoleState|undefined,rTicks:0}
 const relations=[{kind:'role-knowledge',from:R,to:K},{kind:'role-skill',from:R,to:S1},...(options.roleNeedsConnector?[{kind:'role-connection',from:R,to:M}]:[])]
 const load={id:loadId,status:options.unloaded?'unloaded':'active',templateTitle:'安全运营 SOC',templateVersion:'1.2.0',mappingHash:hex('a'),relations,
  items:[{instanceId:K,kind:'knowledge',title:'分诊指南',required:true,status:'pending-adapter'},{instanceId:S1,kind:'skill',title:'告警分诊',required:true,status:'pending-adapter'},{instanceId:S2,kind:'skill',title:'取证规程',required:false,status:'pending-adapter'},{instanceId:S3,kind:'skill',title:'取证脚本',required:false,status:'pending-adapter'},{instanceId:M,kind:'mcp',title:'SIEM 连接',required:false,status:options.tolerant?'instantiated':'pending-adapter'},{instanceId:R,kind:'role',title:'T1 分析师',required:true,status:options.rolePaused?'active':'pending-adapter'},{instanceId:T,kind:'work-template',title:'告警研判',required:false,status:'pending-adapter'},{instanceId:P,kind:'plan',title:'每日交接',required:false,status:'pending-adapter'},{instanceId:G,kind:'plugin',title:'工单插件',required:false,status:'pending-adapter'},...(options.tolerant?[{instanceId:D,kind:'mcp',title:'已解除连接',required:false,status:'detached'}]:[])]}
 for(const item of load.items)if(options.dependencies?.[item.instanceId])Object.assign(item,{modelDependencies:options.dependencies[item.instanceId]})
 const rec=(fn:(endpoint:string,payload:any)=>unknown)=>async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);return fn(endpoint,payload)}
 let clock=0,loadReads=0
 const ports:IndustryPreparePorts={
  ...(options.models?{models:options.models}:{}),modelTitle:()=>'本地语音',
  loads:rec(()=>{if(++loadReads===options.failLoadsAt)throw new Error('宿主暂不可用');return load}),
  knowledge:rec(endpoint=>{
   if(endpoint==='industry-knowledge/instantiate'){state.knowledge={state:'pending',revision:1};state.kTicks=1;return {}}
   if(state.knowledge?.state==='pending'&&!options.knowledgeSlow&&state.kTicks--<=0)state.knowledge={state:'active',revision:2}
   return {items:state.knowledge?[{loadId,itemInstanceId:K,...state.knowledge}]:[]}
  }),
  roles:rec(endpoint=>{
   if(endpoint==='industry-roles/instantiate'){state.role={state:'pending',revision:1,role:null};state.rTicks=1;return {}}
   if(state.role?.state==='pending'&&state.rTicks--<=0)state.role=options.roleFails?{state:'failed',revision:2,role:null,failure:{code:'teloa/conflict',message:'岗位定义冲突。'}}:{state:'paused',revision:2,role:{id:ROLE,version:1,state:'paused'}}
   return {items:state.role?[{loadId,itemInstanceId:R,...state.role}]:[]}
  }),
  skills:rec((endpoint,payload)=>{
   if(endpoint==='skill-installations/list'&&options.usageOrphan)return {items:[],usages:[{loadId,itemInstanceId:S1,installationId:INST}]}
   if(endpoint==='skill-installations/list')return {items:state.skill?[{id:INST,source:publicSource,state:'installed',version:1}]:[],usages:state.skill?[{loadId,itemInstanceId:S1,installationId:INST}]:[]}
   if(endpoint==='skill-installations/preview'){
    const id=payload.source.itemInstanceId
    if(id===S1&&options.tolerant)throw new Error('预览失败')
    return id===S2?{bundleHash:hex('b'),trustHash:hex('c'),files:files('SKILL.md')}:id===S3?{bundleHash:hex('9'),files:files('SKILL.md','scripts/collect.py')}:{bundleHash:options.s1Bundle??hex('d'),files:files(...(options.s1Files??['SKILL.md'])),...(options.s1Trust===null?{}:{trust:options.s1Trust??officialTrust,trustHash:options.s1TrustHash??hex('7')})}
   }
   if(endpoint==='skill-installations/install'){state.skill=true;return {installation:{id:INST,source:publicSource,state:'installed'},source:publicSource}}
   return {installationId:INST,scope:'default-workspace',state:options.observeState??'available'}
  }),
  mcp:rec(endpoint=>{
   if(endpoint==='industry-mcp-connections/instantiate'){state.mcp=options.connectorDetached?'detached':'needs_connection';return {}}
   if(options.tolerant)return {items:[],errors:[{instanceId:'e0000000-0000-4000-8000-000000000000',code:'teloa/source-unavailable'}]}
   return {items:state.mcp?[{loadId,itemInstanceId:M,state:state.mcp,revision:1}]:[]}
  }),
  dataSources:rec(()=>({items:[]})),executionTools:rec(()=>({items:[]})),
  plugins:rec(()=>({items:[{loadId,itemInstanceId:G,state:'needs_install',revision:1}]})),
  lifecycle:async payload=>{calls.push(['roles/lifecycle',payload]);state.role={state:'active',revision:3,role:{id:ROLE,version:2,state:'active'}};return {role:state.role.role}},
  sleep:async()=>{resting();if(options.hold)await held},now:()=>clock++,waitMs:options.knowledgeSlow?3:20000,
  ...(options.audit?{audit:(entry:unknown)=>{options.audit!.push(entry)}}:{}),
 }
 return {calls,release,sleeping,handler:createIndustryPrepareHandler(owner,async()=>ports),writes:()=>calls.filter(([endpoint])=>mutating.has(endpoint))}
}
const byId=(r:any,id:string)=>r.rows.find((row:any)=>row.itemInstanceId===id)
// 官方目录出品的纯内容技能信任声明（official-catalog.ts officialCatalogTrust 的形状）
const officialTrust={publisher:'Teloa 官方目录',repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'>=0.2.0-alpha.2',dsh:'0.1.6-alpha.1'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'approved',summary:'Teloa 官方目录收录'}}

test('readiness：按规格 §3 分类（技能经 usages 判已装、带信任声明或含脚本的技能逐个确认）、计数与 64 位摘要；参数白名单',async()=>{
 const w=world(),r:any=await w.handler('industry-loads/readiness',{loadId})
 assert.deepEqual(r.counts,{ready:0,auto:4,needsUser:3,optional:2,pending:0})
 assert.deepEqual([K,S1,M,R].map(id=>byId(r,id).step),['knowledge','skill','mcp','role'])
 assert.deepEqual([S2,S3,G,T,P].map(id=>byId(r,id).entry),['skill-confirm','skill-confirm','plugin','task-form','plan-form'])
 assert.deepEqual(Object.keys(byId(r,K)).sort(),['entry','itemInstanceId','kind','state','step','title'])
 assert.match(r.digest,/^[0-9a-f]{64}$/);assert.equal(r.status,'active');assert.equal(w.writes().length,0)
 await assert.rejects(w.handler('industry-loads/readiness',{loadId,extra:1}),/未知字段/)
 await assert.rejects(w.handler('industry-loads/readiness',{loadId:'x'}),/UUID/)
})

test('prepare：按顺序执行、子请求 id 由宿主派生、只上岗本次新建且依赖都就绪的岗位；再读清单技能与岗位为已就绪',async()=>{
 const w=world(),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(w.writes().map(([endpoint])=>endpoint),['industry-knowledge/instantiate','skill-installations/install','industry-mcp-connections/instantiate','industry-roles/instantiate','roles/lifecycle'])
 const payload=(endpoint:string)=>w.writes().find(([e])=>e===endpoint)![1]
 assert.equal(payload('industry-knowledge/instantiate').requestId,prepareRequestId(owner,loadId,K,'knowledge',r.digest))
 assert.equal(payload('industry-roles/instantiate').requestId,prepareRequestId(owner,loadId,R,'role',r.digest))
 assert.deepEqual(payload('skill-installations/install'),{requestId:prepareRequestId(owner,loadId,S1,'skill',r.digest),source:{kind:'industry',loadId,itemInstanceId:S1},expectedBundleHash:hex('d'),expectedTrustHash:hex('7')})
 assert.deepEqual(payload('roles/lifecycle'),{roleId:ROLE,expectedVersion:1,action:'resume',reason:'方案一键准备'})
 assert.deepEqual(receipt.results.map((x:any)=>[x.step,x.outcome]),[['knowledge','done'],['skill','done'],['mcp','done'],['role','done'],['role-resume','done']])
 assert.deepEqual(receipt.readiness.counts,{ready:3,auto:0,needsUser:4,optional:2,pending:0})
 const again:any=await w.handler('industry-loads/readiness',{loadId})
 assert.deepEqual([S1,R].map(id=>byId(again,id).state),['ready','ready'])
})

test('prepare：原本暂停的岗位归需要你操作、不自动恢复；新建岗位的关联连接未就绪时保持暂停',async()=>{
 const paused=world({rolePaused:true}),a:any=await paused.handler('industry-loads/readiness',{loadId})
 assert.equal(byId(a,R).entry,'role-resume')
 await paused.handler('industry-loads/prepare',{loadId,expectedDigest:a.digest})
 assert.equal(paused.writes().some(([endpoint])=>endpoint==='roles/lifecycle'||endpoint==='industry-roles/instantiate'),false)
 const linked=world({roleNeedsConnector:true}),b:any=await linked.handler('industry-loads/readiness',{loadId})
 const receipt:any=await linked.handler('industry-loads/prepare',{loadId,expectedDigest:b.digest})
 assert.deepEqual(receipt.results.filter((x:any)=>x.itemInstanceId===R).map((x:any)=>[x.step,x.outcome]),[['role','done'],['role-resume','skipped']])
 assert.equal(linked.writes().some(([endpoint])=>endpoint==='roles/lifecycle'),false)
 assert.equal(byId(receipt.readiness,R).entry,'role-resume')
})

test('prepare：同摘要并发只执行一次并复用全部完成的回执；摘要过期 version-conflict；参数白名单',async()=>{
 const w=world(),r:any=await w.handler('industry-loads/readiness',{loadId})
 const [a,b]=await Promise.all([w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}),w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})])
 const c=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(a,b);assert.deepEqual(a,c);assert.equal(w.writes().length,5)
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:'0'.repeat(64)}),/状态已变化/)
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:'zz'}),/64 位/)
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest,requestId:loadId}),/未知字段/)
})

test('prepare：同一加载串行；首个调用方断开不影响底层执行，共用者拿到结果，排队的新摘要复核后拒绝',async()=>{
 const w=world({hold:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const quit=new AbortController()
 const first=w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest},quit.signal)
 const second=w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 await w.sleeping
 const mid:any=await w.handler('industry-loads/readiness',{loadId})
 assert.notEqual(mid.digest,r.digest)
 const late=w.handler('industry-loads/prepare',{loadId,expectedDigest:mid.digest})
 quit.abort();await assert.rejects(first)
 w.release()
 assert.equal(((await second) as any).results.at(-1).outcome,'done')
 await assert.rejects(late,/状态已变化/)
 assert.equal(w.writes().filter(([endpoint])=>endpoint==='industry-knowledge/instantiate').length,1)
})

test('prepare：岗位失败归需要你操作且不上岗；含失败的回执不缓存',async()=>{
 const w=world({roleFails:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 const role=receipt.results.find((x:any)=>x.step==='role')
 assert.deepEqual([role.outcome,role.code],['failed','teloa/conflict'])
 assert.equal(w.writes().some(([endpoint])=>endpoint==='roles/lifecycle'),false)
 assert.equal(receipt.results.filter((x:any)=>x.outcome==='done').length,3)
 assert.equal(byId(receipt.readiness,R).entry,'role-retry')
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}),/状态已变化/)
})

test('prepare：资料等待超时记为处理中，岗位跳过且不实例化',async()=>{
 const w=world({knowledgeSlow:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.equal(receipt.results.find((x:any)=>x.step==='knowledge').outcome,'pending')
 assert.equal(receipt.results.find((x:any)=>x.step==='role').outcome,'skipped')
 assert.equal(w.writes().some(([endpoint])=>endpoint==='industry-roles/instantiate'),false)
})

test('readiness：逐条容错——技能预览失败与连接器列表读错的项归需要你操作、不重复创建；已解除条目不进清单',async()=>{
 const w=world({tolerant:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 assert.deepEqual([byId(r,S1).entry,byId(r,M).entry],['skill-confirm','connector-settings']);assert.equal(byId(r,D),undefined)
 await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.equal(w.writes().some(([endpoint])=>endpoint==='skill-installations/install'||endpoint==='industry-mcp-connections/instantiate'),false)
})

test('prepare：已卸载方案 conflict，不写任何东西',async()=>{
 const w=world({unloaded:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}),/已卸载/)
 assert.equal(w.writes().length,0)
})

test('prepare：新建岗位关联的连接已解除（清单无法归类）时不上岗',async()=>{
 const w=world({roleNeedsConnector:true,connectorDetached:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(receipt.results.filter((x:any)=>x.itemInstanceId===R).map((x:any)=>[x.step,x.outcome]),[['role','done'],['role-resume','skipped']])
 assert.equal(w.writes().some(([endpoint])=>endpoint==='roles/lifecycle'),false)
})

test('readiness：技能文件按白名单判定——仅文本、数据与常见图片可一键，其余（含无扩展名）逐个确认',async()=>{
 for(const [paths,entry] of [[['SKILL.md','ref/guide.txt','data.json','a.yaml','b.yml','c.csv','img/a.PNG','img/b.jpeg','img/c.webp'],null],[['SKILL.md','run'],'skill-confirm'],[['SKILL.md','tool.lua'],'skill-confirm'],[['SKILL.md','icon.svg'],'skill-confirm'],[['SKILL.md','ref/.md'],'skill-confirm']] as [string[],string|null][]){
  const r:any=await world({s1Files:paths}).handler('industry-loads/readiness',{loadId})
  assert.equal(byId(r,S1).entry,entry,paths.join(','));assert.equal(byId(r,S1).state,entry?'needs-user':'auto')
 }
})

test('readiness：技能有使用登记但安装记录缺失时归需要你操作（逐个确认）',async()=>{
 const r:any=await world({usageOrphan:true}).handler('industry-loads/readiness',{loadId})
 assert.deepEqual([byId(r,S1).state,byId(r,S1).entry],['needs-user','skill-confirm'])
})

test('prepare：技能观测状态映射到固定枚举，回执不透传原生状态文本',async()=>{
 for(const [raw,pattern] of [['shadowed',/同名/],['disabled',/停用/],['伪造\n状态',/未知/]] as [string,RegExp][]){
  const w=world({observeState:raw}),r:any=await w.handler('industry-loads/readiness',{loadId})
  const skill=(await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}) as any).results.find((x:any)=>x.step==='skill')
  assert.equal(skill.outcome,'failed');assert.match(skill.message,pattern);assert.equal(skill.message.includes(raw),false)
 }
})

test('prepare：执行后读取最终清单失败时照常返回结果，清单标为待刷新且不缓存',async()=>{
 const w=world({failLoadsAt:4}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.equal(receipt.readiness,null);assert.equal(receipt.results.length,5);assert.ok(receipt.results.every((x:any)=>x.outcome==='done'))
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}),/状态已变化/)
})

test('readiness/prepare：官方目录已审核、纯内容、无联网与执行权限的技能进一键——清单行带信任摘要，安装带预览 trustHash',async()=>{
 const w=world({s1Trust:officialTrust}),r:any=await w.handler('industry-loads/readiness',{loadId})
 assert.deepEqual([byId(r,S1).state,byId(r,S1).step,byId(r,S1).entry],['auto','skill',null])
 assert.deepEqual(byId(r,S1).trust,{publisher:'Teloa 官方目录',license:'MIT'})
 assert.equal('trust' in byId(r,K),false);assert.equal('trust' in byId(r,S2),false)
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(w.writes().find(([e])=>e==='skill-installations/install')![1],{requestId:prepareRequestId(owner,loadId,S1,'skill',r.digest),source:{kind:'industry',loadId,itemInstanceId:S1},expectedBundleHash:hex('d'),expectedTrustHash:hex('7')})
 assert.deepEqual(receipt.results.map((x:any)=>[x.step,x.outcome]),[['knowledge','done'],['skill','done'],['mcp','done'],['role','done'],['role-resume','done']])
})

test('readiness：信任声明按字段判定——联网或执行权限、非官方发布者、未通过审核、签名无效、带插件或外部能力、含脚本的技能仍逐个确认',async()=>{
 const cases:[string,Record<string,unknown>,string[]?][]=[
  ['联网',{...officialTrust,permissions:[{id:'network',description:'需要联网',required:true}]}],
  ['执行工具',{...officialTrust,permissions:[{id:'tool:gh',description:'使用工具 gh',required:true}]}],
  ['非官方发布者',{...officialTrust,publisher:'anthropic'}],
  ['待审核',{...officialTrust,review:{conclusion:'needs-review',summary:'x'}}],
  ['签名无效',{...officialTrust,signature:{status:'invalid',signer:null}}],
  ['插件',{...officialTrust,plugins:[{id:'p',version:'1.0.0',required:true}]}],
  ['外部能力',{...officialTrust,externalCapabilities:[{id:'m',kind:'mcp',required:true}]}],
  ['未列入白名单的权限',{...officialTrust,permissions:[{id:'fs:read',description:'读文件',required:false}]}],
  ['含脚本',officialTrust,['SKILL.md','scripts/run.md']],
 ]
 for(const [label,trust,paths] of cases){
  const r:any=await world({s1Trust:trust,...(paths?{s1Files:paths}:{})}).handler('industry-loads/readiness',{loadId})
  assert.deepEqual([byId(r,S1).state,byId(r,S1).entry],['needs-user','skill-confirm'],label);assert.equal('trust' in byId(r,S1),false,label)
 }
})

test('readiness：没有信任声明的技能不进一键，逐个确认',async()=>{
 const r:any=await world({s1Trust:null}).handler('industry-loads/readiness',{loadId})
 assert.deepEqual([byId(r,S1).state,byId(r,S1).entry],['needs-user','skill-confirm']);assert.equal('trust' in byId(r,S1),false)
})

test('prepare：读清单后信任声明或包内容变化，旧摘要 version-conflict，一次安装都不做',async()=>{
 const drifts:[string,(o:Options)=>void][]=[
  ['信任声明加联网',o=>{o.s1Trust={...officialTrust,permissions:[{id:'network',description:'需要联网',required:true}]};o.s1TrustHash=hex('6')}],
  ['包内容加脚本',o=>{o.s1Files=['SKILL.md','scripts/x.sh'];o.s1Bundle=hex('5')}],
  ['仅信任摘要变化',o=>{o.s1TrustHash=hex('6')}],
  ['仅包摘要变化',o=>{o.s1Bundle=hex('5')}],
 ]
 for(const [label,drift] of drifts){
  const o:Options={},w=world(o),r:any=await w.handler('industry-loads/readiness',{loadId})
  assert.equal(byId(r,S1).state,'auto',label)
  drift(o)
  await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}),/状态已变化/,label)
  assert.equal(w.writes().length,0,label)
 }
})

test('prepare：没有可一键完成的项时拒绝（与会话口径一致），不写任何东西',async()=>{
 const w=world(),r:any=await w.handler('industry-loads/readiness',{loadId})
 const done:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 const writes=w.writes().length
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:done.readiness.digest}),/没有可一键完成的项/)
 assert.equal(w.writes().length,writes)
})

test('prepare：每次真正执行写一条汇总审计（加载、摘要、渠道、各步骤计数、装了哪些技能）；摘要不符不写',async()=>{
 const audit:unknown[]=[],w=world({audit}),r:any=await w.handler('industry-loads/readiness',{loadId})
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:'0'.repeat(64)}),/状态已变化/)
 assert.equal(audit.length,0)
 await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest},undefined,'session')
 await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(audit,[{loadId,digest:r.digest,channel:'session',outcomes:{done:5,pending:0,failed:0,skipped:0},steps:{knowledge:1,skill:1,mcp:1,role:1,'role-resume':1},skills:[{itemInstanceId:S1,trustHash:hex('7'),outcome:'done'}]}])
})


test('模型按入口阻断且共享探测；不下载，准备后恢复原入口，停用导致旧确认摘要失效',async()=>{
 const dependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text' as const,required:true}
 let phase:'disabled'|'ready'='disabled',probes=0
 const w=world({dependencies:{[S1]:[dependency],[T]:[dependency],[S2]:[{...dependency,required:false}]},models:async()=>{probes++;return phase}})
 const before:any=await w.handler('industry-loads/readiness',{loadId})
 assert.equal(probes,1)
 assert.equal(byId(before,S1).entry,'model-settings');assert.equal(byId(before,T).entry,'model-settings')
 assert.equal(byId(before,S2).entry,'skill-confirm');assert.equal(byId(before,K).state,'auto')
 assert.equal(byId(before,S1).models[0].phase,'disabled');assert.equal(w.writes().length,0)
 phase='ready'
 const ready:any=await w.handler('industry-loads/readiness',{loadId})
 assert.equal(byId(ready,S1).state,'auto');assert.equal(byId(ready,T).entry,'task-form')
 assert.notEqual(before.digest,ready.digest)
 phase='disabled'
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:ready.digest}),/状态已变化/)
 assert.equal(w.writes().length,0)
})
