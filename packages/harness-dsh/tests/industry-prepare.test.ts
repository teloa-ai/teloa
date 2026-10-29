import test from 'node:test'
import {WorkError,type IndustryModelDependency,type IndustryModelProbe} from '@teloa/contract'
import assert from 'node:assert/strict'
import {createIndustryPrepareHandler,prepareRequestId,type IndustryPreparePorts} from '../src/industry-prepare.ts'

const owner='local:teloa-owner',loadId='77777777-7777-4777-8777-777777777777',otherLoad='78888888-7777-4777-8777-777777777777'
const K='11111111-1111-4111-8111-111111111111',S1='22222222-2222-4222-8222-222222222222',S2='23333333-2222-4222-8222-222222222222',S3='24444444-2222-4222-8222-222222222222',M='44444444-4444-4444-8444-444444444444'
const R='55555555-5555-4555-8555-555555555555',T='66666666-6666-4666-8666-666666666666',P='88888888-8888-4888-8888-888888888888',G='99999999-9999-4999-8999-999999999999',D='12121212-1212-4121-8121-121212121212'
const ROLE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',INST='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const mutating=new Set(['industry-knowledge/instantiate','skill-installations/install','industry-mcp-connections/instantiate','industry-plugins/instantiate','industry-plugins/install','industry-plugins/enable','industry-roles/instantiate','roles/edit','roles/lifecycle'])
// 原生技能名与正文摘要：绑定只认安装记录与实际观测一致的这一份。
const NATIVE='grok-0123456789abcdef01234567-skill-0001',BODY='3'.repeat(64)
const roleDefinition={name:'告警分诊员',kind:'employee',scopes:['soc'],duty:'按模板方法分诊告警。',dataScope:'仅本人提供的告警。',executionScope:'沿用当前授权。',skills:[] as string[],knowledge:[] as string[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
const hex=(c:string)=>c.repeat(64)
// 真实形状：公共技能安装的 source 属于首次安装它的加载（industry-public），本加载只经 usages 映射过去（skill-installations.ts:12、:25）
const publicSource={kind:'industry-public',contentId:'c0000000-0000-4000-8000-000000000000',contentHash:hex('e'),resourceId:'alert-triage',resourceVersion:'1.0.0',loadId:otherLoad,itemInstanceId:'c1111111-0000-4000-8000-000000000000',sourceContentId:'c2222222-0000-4000-8000-000000000000',sourceContentHash:hex('f'),sourceResourceId:'alert-triage',sourceResourceVersion:'1.0.0'}
const files=(...paths:string[])=>paths.map(path=>({path,hash:hex('1'),size:10}))
// 本加载条目经预览解析出的固定引用：公共来源只认同一 sourceContent/sourceResource（首次安装可来自另一加载），自装来源须指回本加载本条目
const INST2='cccccccc-cccc-4ccc-8ccc-cccccccccccc',LOAD_CONTENT='c4444444-0000-4000-8000-000000000000'
const fixedPublic={kind:'industry-public',loadId,itemInstanceId:S1,contentId:LOAD_CONTENT,contentHash:hex('8'),resourceId:'alert-triage',resourceVersion:'1.0.0',sourceContentId:publicSource.sourceContentId,sourceContentHash:publicSource.sourceContentHash,sourceResourceId:publicSource.sourceResourceId,sourceResourceVersion:publicSource.sourceResourceVersion}
const localSource={kind:'industry-local',loadId,itemInstanceId:S1,contentId:LOAD_CONTENT,contentHash:hex('8'),resourceId:'skill-0001',resourceVersion:'1.0.0'}

type Options={models?:IndustryModelProbe;dependencies?:Record<string,IndustryModelDependency[]>;roleFails?:boolean;knowledgeSlow?:boolean;unloaded?:boolean;rolePaused?:boolean;roleNeedsConnector?:boolean;tolerant?:boolean;hold?:boolean;connectorDetached?:boolean;s1Files?:string[];s1Trust?:Record<string,unknown>|null;s1TrustHash?:string;s1Bundle?:string;audit?:unknown[];usageOrphan?:boolean;observeState?:string;failLoadsAt?:number
 // 方法绑定：事先显式安装、无关联方法、绑定前的观测/替换/撤销/来源/关联漂移、本人已改员工、保存或上岗失败、未接入绑定端口
 skillPreinstalled?:boolean;noRoleSkill?:boolean;bindObserve?:string;bindReplaced?:boolean;bindRevoked?:boolean;atomicSource?:boolean;mappingDrift?:boolean;roleEditedByUser?:boolean;editFails?:boolean;lifecycleFails?:boolean;noRoleRecords?:boolean
 // 安装身份：自装来源、同名但不同公共来源、绑定前 usage 迁到另一份同版本安装
 localSkill?:boolean;foreignPublic?:boolean;bindMigrated?:boolean
 // 依赖应用：null 为尚未登记；信任结论、预览失败、安装与启用后的状态；员工经 role-connection 依赖该应用
 pluginState?:string|null;pluginTrust?:'verified'|'unverified'|'rejected';pluginPreviewFails?:boolean;pluginInstallTo?:string;pluginEnableTo?:string;roleNeedsPlugin?:boolean}
type RoleRecord=typeof roleDefinition&{id:string;ownerId:string;version:number;state:string;createdAt:string;updatedAt:string}
const roleRecord=(version:number,state:string):RoleRecord=>({...structuredClone(roleDefinition),id:ROLE,ownerId:owner,version,state,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z'})
function world(options:Options={}){
 const calls:[string,any][]=[]
 let release=()=>{},resting=()=>{}
 const held=new Promise<void>(resolve=>{release=resolve}),sleeping=new Promise<void>(resolve=>{resting=resolve})
 type RoleState={state:string;revision:number;failure?:unknown}
 const state={knowledge:undefined as undefined|{state:string;revision:number},kTicks:0,skill:!!options.skillPreinstalled,mcp:undefined as string|undefined,role:(options.rolePaused?{state:'paused',revision:1}:undefined) as RoleState|undefined,rTicks:0,record:options.rolePaused?roleRecord(3,'paused'):undefined as RoleRecord|undefined,binding:false,migrated:false,
  plugin:{state:options.pluginState===undefined?'needs_install':options.pluginState,revision:1} as {state:string|null;revision:number}}
 const relations=[{kind:'role-knowledge',from:R,to:K},...(options.noRoleSkill?[]:[{kind:'role-skill',from:R,to:S1}]),...(options.roleNeedsConnector?[{kind:'role-connection',from:R,to:M}]:[]),...(options.roleNeedsPlugin?[{kind:'role-connection',from:R,to:G}]:[])]
 // 另一份安装（INST2）除 ID 外与原安装完全相同：版本也同为 1，只比版本无法发现迁移
 const installation=(id=INST)=>({id,ownerId:owner,source:options.atomicSource?{kind:'atomic',contentId:'c3333333-0000-4000-8000-000000000000',contentHash:hex('e'),resourceId:'alert-triage',resourceVersion:'1.0.0'}:options.localSkill?localSource:options.foreignPublic?{...publicSource,sourceContentId:'c5555555-0000-4000-8000-000000000000',sourceContentHash:hex('6')}:publicSource,bundleHash:options.s1Bundle??hex('d'),native:{name:NATIVE,description:'告警分诊',modelInvocable:true,userInvocable:true,bodyHash:BODY},state:'installed',version:1,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z'})
 const load={id:loadId,status:options.unloaded?'unloaded':'active',templateTitle:'安全运营 SOC',templateVersion:'1.2.0',mappingHash:hex('a'),relations,
  items:[{instanceId:K,kind:'knowledge',title:'分诊指南',required:true,status:'pending-adapter'},{instanceId:S1,kind:'skill',title:'告警分诊',required:true,status:'pending-adapter'},{instanceId:S2,kind:'skill',title:'取证规程',required:false,status:'pending-adapter'},{instanceId:S3,kind:'skill',title:'取证脚本',required:false,status:'pending-adapter'},{instanceId:M,kind:'mcp',title:'SIEM 连接',required:false,status:options.tolerant?'instantiated':'pending-adapter'},{instanceId:R,kind:'role',title:'T1 分析师',required:true,status:options.rolePaused?'active':'pending-adapter'},{instanceId:T,kind:'work-template',title:'告警研判',required:false,status:'pending-adapter'},{instanceId:P,kind:'plan',title:'每日交接',required:false,status:'pending-adapter'},{instanceId:G,kind:'plugin',title:'工单插件',required:false,status:'pending-adapter',version:'1.0.0'},...(options.tolerant?[{instanceId:D,kind:'mcp',title:'已解除连接',required:false,status:'detached'}]:[])]}
 for(const item of load.items)if(options.dependencies?.[item.instanceId])Object.assign(item,{modelDependencies:options.dependencies[item.instanceId]})
 const rec=(fn:(endpoint:string,payload:any)=>unknown)=>async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);return fn(endpoint,payload)}
 let clock=0,loadReads=0
 const ports:IndustryPreparePorts={
  ...(options.models?{models:options.models}:{}),modelTitle:()=>'本地语音',
  loads:rec(()=>{if(++loadReads===options.failLoadsAt)throw new Error('宿主暂不可用');return options.mappingDrift&&state.binding?{...load,mappingHash:hex('b')}:load}),
  knowledge:rec(endpoint=>{
   if(endpoint==='industry-knowledge/instantiate'){state.knowledge={state:'pending',revision:1};state.kTicks=1;return {}}
   if(state.knowledge?.state==='pending'&&!options.knowledgeSlow&&state.kTicks--<=0)state.knowledge={state:'active',revision:2}
   return {items:state.knowledge?[{loadId,itemInstanceId:K,...state.knowledge}]:[]}
  }),
  roles:rec(endpoint=>{
   if(endpoint==='industry-roles/instantiate'){state.role={state:'pending',revision:1};state.rTicks=1;return {}}
   if(state.role?.state==='pending'&&state.rTicks--<=0){
    if(options.roleFails)state.role={state:'failed',revision:2,failure:{code:'teloa/conflict',message:'岗位定义冲突。'}}
    else{state.role={state:'paused',revision:2};state.record=roleRecord(1,'paused')}
   }
   // 实例行里的岗位投影来自原员工记录，绑定与上岗后的版本随之推进
   const role=state.role&&state.role.state!=='pending'&&state.role.state!=='failed'&&state.record?{id:ROLE,version:state.record.version,state:state.record.state}:null
   return {items:state.role?[{loadId,itemInstanceId:R,...state.role,role}]:[]}
  }),
  skills:rec((endpoint,payload)=>{
   if(endpoint==='skill-installations/list'&&options.usageOrphan)return {items:[],usages:[{loadId,itemInstanceId:S1,installationId:INST}]}
   if(endpoint==='skill-installations/list'){
    const used=state.migrated||options.bindMigrated&&state.binding?INST2:INST
    return {items:state.skill?[installation(INST),...(used===INST2?[installation(INST2)]:[])]:[],usages:state.skill&&!(options.bindRevoked&&state.binding)?[{loadId,itemInstanceId:S1,installationId:used}]:[]}
   }
   if(endpoint==='skill-installations/preview'){
    const id=payload.source.itemInstanceId
    if(id===S1&&options.tolerant)throw new Error('预览失败')
    return id===S2?{bundleHash:hex('b'),trustHash:hex('c'),files:files('SKILL.md')}:id===S3?{bundleHash:hex('9'),files:files('SKILL.md','scripts/collect.py')}:{source:options.localSkill?localSource:fixedPublic,bundleHash:options.s1Bundle??hex('d'),native:{name:NATIVE,description:'告警分诊',modelInvocable:true,userInvocable:true,bodyHash:BODY},files:files(...(options.s1Files??['SKILL.md'])),...(options.s1Trust===null?{}:{trust:options.s1Trust??officialTrust,trustHash:options.s1TrustHash??hex('7')})}
   }
   if(endpoint==='skill-installations/install'){state.skill=true;return {installation:installation(),source:publicSource}}
   const observed=state.binding&&options.bindObserve?options.bindObserve:options.observeState??'available'
   return {installationId:INST,scope:'default-workspace',state:observed,current:observed==='available'||observed==='shadowed'?{name:NATIVE,description:'告警分诊',modelInvocable:true,userInvocable:true,bodyHash:state.binding&&options.bindReplaced?hex('4'):BODY,provider:'teloa-market',source:'managed'}:null}
  }),
  mcp:rec(endpoint=>{
   if(endpoint==='industry-mcp-connections/instantiate'){state.mcp=options.connectorDetached?'detached':'needs_connection';return {}}
   if(options.tolerant)return {items:[],errors:[{instanceId:'e0000000-0000-4000-8000-000000000000',code:'teloa/source-unavailable'}]}
   return {items:state.mcp?[{loadId,itemInstanceId:M,state:state.mcp,revision:1}]:[]}
  }),
  dataSources:rec(()=>({items:[]})),executionTools:rec(()=>({items:[]})),
  plugins:rec(endpoint=>{
   const row=()=>({id:PI,loadId,itemInstanceId:G,state:state.plugin.state,revision:state.plugin.revision,definition:{format:'teloa.plugin/v1',registry:'npm',packageName:'@example/ticket',version:'1.0.0'}})
   if(endpoint==='industry-plugins/list')return {items:state.plugin.state?[row()]:[]}
   if(endpoint==='industry-plugins/instantiate'){state.plugin={state:'needs_install',revision:1};return row()}
   if(endpoint==='industry-plugins/preview'){if(options.pluginPreviewFails)throw new WorkError('teloa/dependency-unavailable','DSH 扩展安装服务不可用。');return pluginPreview(options.pluginTrust??'verified')}
   if(endpoint==='industry-plugins/install'){state.plugin={state:options.pluginInstallTo??'pending-enable',revision:state.plugin.revision+1};return row()}
   if(endpoint==='industry-plugins/enable'){state.plugin={state:options.pluginEnableTo??'active',revision:state.plugin.revision+1};return row()}
   throw new Error('意外的扩展接口：'+endpoint)
  }),
  // 原 roles handler 的列表与 CAS 编辑；上岗同样按版本核对
  ...(options.noRoleRecords?{}:{roleRecords:rec((endpoint,payload)=>{
   if(endpoint==='roles/list'){state.binding=true;if(options.roleEditedByUser&&state.record?.version===1)state.record={...state.record,version:2,duty:'本人改过的职责。'};return state.record?[structuredClone(state.record)]:[]}
   if(endpoint!=='roles/edit')throw new Error('意外的员工接口：'+endpoint)
   if(options.editFails||!state.record||payload.expectedVersion!==state.record.version)throw new WorkError('teloa/version-conflict','员工已被修改，请读取新版本后复核。')
   state.record={...state.record,...structuredClone(payload.fields),version:state.record.version+1};return structuredClone(state.record)
  })}),
  lifecycle:async payload=>{
   calls.push(['roles/lifecycle',payload])
   if(options.lifecycleFails)throw new WorkError('teloa/conflict','员工暂不能上岗。')
   if(!state.record||(payload as {expectedVersion:number}).expectedVersion!==state.record.version)throw new WorkError('teloa/version-conflict','员工已被修改，请读取新版本后复核。')
   state.record={...state.record,state:'active',version:state.record.version+1};state.role={state:'active',revision:3}
   return {role:{id:ROLE,version:state.record.version,state:'active'}}
  },
  sleep:async()=>{resting();if(options.hold)await held},now:()=>clock++,waitMs:options.knowledgeSlow?3:20000,
  ...(options.audit?{audit:(entry:unknown)=>{options.audit!.push(entry)}}:{}),
 }
 return {ports,calls,release,sleeping,handler:createIndustryPrepareHandler(owner,async()=>ports),writes:()=>calls.filter(([endpoint])=>mutating.has(endpoint)),record:()=>state.record,migrate:()=>{state.migrated=true}}
}
const byId=(r:any,id:string)=>r.rows.find((row:any)=>row.itemInstanceId===id)
// 官方目录出品的纯内容技能信任声明（official-catalog.ts officialCatalogTrust 的形状）
// 行业扩展安装预览（market-plugin-installation.ts 的形状）
const PI='9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a'
const pluginPreview=(status:'verified'|'unverified'|'rejected')=>({schema:'teloa.market-plugin-install-preview/v1',source:{registry:'npm',packageName:'@example/ticket',version:'1.0.0'},trust:{status,publisher:'Example Labs',integrity:'sha512-AAAA'},bundleHash:hex('5'),permissionSummary:{permissions:[{id:'dsh.bundle',description:'将加载 DSH 宿主配置层。',required:true}]}})
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
 // 新员工上岗前先经原 roles/edit 绑定同一加载已装且可用的方法（v1→v2），再按新版本上岗
 assert.deepEqual(w.writes().map(([endpoint])=>endpoint),['industry-knowledge/instantiate','skill-installations/install','industry-mcp-connections/instantiate','industry-roles/instantiate','roles/edit','roles/lifecycle'])
 const payload=(endpoint:string)=>w.writes().find(([e])=>e===endpoint)![1]
 assert.equal(payload('industry-knowledge/instantiate').requestId,prepareRequestId(owner,loadId,K,'knowledge',r.digest))
 assert.equal(payload('industry-roles/instantiate').requestId,prepareRequestId(owner,loadId,R,'role',r.digest))
 assert.deepEqual(payload('skill-installations/install'),{requestId:prepareRequestId(owner,loadId,S1,'skill',r.digest),source:{kind:'industry',loadId,itemInstanceId:S1},expectedBundleHash:hex('d'),expectedTrustHash:hex('7')})
 assert.deepEqual(payload('roles/edit'),{roleId:ROLE,expectedVersion:1,expectedProfile:{name:roleDefinition.name},fields:{...roleDefinition,skills:[NATIVE]}})
 assert.deepEqual(payload('roles/lifecycle'),{roleId:ROLE,expectedVersion:2,action:'resume',reason:'方案一键准备'})
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

test('prepare：公开 activate:false 建员工并绑定方法后保持暂停；非法值拒绝且不落写；paused 回执键与默认准备隔离',async()=>{
 const w=world(),r:any=await w.handler('industry-loads/readiness',{loadId})
 for(const activate of [true,'false',0,null,{},[]])await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest,activate}),/activate 只能省略或为 false/)
 assert.equal(w.writes().length,0,'非法 activate 不执行任何写入')
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest,activate:false})
 // 与宿主内部 options.activate:false 同一语义：员工建好、方法绑定，但不调用 roles/lifecycle 上岗。
 assert.deepEqual(w.writes().map(([endpoint])=>endpoint),['industry-knowledge/instantiate','skill-installations/install','industry-mcp-connections/instantiate','industry-roles/instantiate','roles/edit'])
 assert.deepEqual(receipt.results.filter((x:any)=>x.itemInstanceId===R).map((x:any)=>[x.step,x.outcome,x.message]),[['role','done',null],['role-resume','skipped','员工已创建并保持暂停：请检查后在「员工」中恢复。']])
 assert.equal(byId(receipt.readiness,R).entry,'role-resume');assert.equal(w.record()!.state,'paused')
 // 带 skipped 的回执不进缓存：旧摘要再来（无论是否 activate:false）都按最新状态复核后拒绝；新清单里员工归需要你操作，默认准备也没有可一键项，不会补上岗。
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest,activate:false}),/状态已变化/)
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}),/状态已变化/)
 const again:any=await w.handler('industry-loads/readiness',{loadId});assert.equal(byId(again,R).state,'needs-user');assert.equal(again.counts.auto,0)
 await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:again.digest}),/没有可一键完成的项/)
 assert.equal(w.writes().length,5,'默认准备没有借 paused 结果重复执行或补上岗');assert.equal(w.record()!.state,'paused')
})

test('prepare：同摘要并发只执行一次并复用全部完成的回执；摘要过期 version-conflict；参数白名单',async()=>{
 const w=world(),r:any=await w.handler('industry-loads/readiness',{loadId})
 const [a,b]=await Promise.all([w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}),w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})])
 const c=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(a,b);assert.deepEqual(a,c);assert.equal(w.writes().length,6);assert.equal(w.writes().filter(([endpoint])=>endpoint==='roles/edit').length,1)
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

test('readiness：已装技能被遮蔽、停用、缺失或无法核验时不算就绪，也不重复安装',async()=>{
 for(const observed of ['shadowed','disabled','missing','unknown']){
  const w=world({observeState:observed}),r:any=await w.handler('industry-loads/readiness',{loadId})
  const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
  assert.deepEqual([byId(receipt.readiness,S1).state,byId(receipt.readiness,S1).entry],['needs-user','skill-confirm'])
  const writes=w.writes().length,again:any=await w.handler('industry-loads/readiness',{loadId})
  assert.deepEqual([byId(again,S1).state,byId(again,S1).entry],['needs-user','skill-confirm'])
  assert.equal(w.writes().length,writes)
 }
})

test('prepare：执行后读取最终清单失败时照常返回结果，清单标为待刷新且不缓存',async()=>{
 // 第 5 次读加载才是执行后的最终清单（第 4 次是绑定方法前的关联复核）
 const w=world({failLoadsAt:5}),r:any=await w.handler('industry-loads/readiness',{loadId})
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

// ---- 方法绑定：已显式安装且实际可用的同一加载 role-skill，只绑到本批首建的暂停员工（v1），经原 roles/edit 保存后再上岗
const endpoints=(w:ReturnType<typeof world>)=>w.writes().map(([endpoint])=>endpoint)
const roleResults=(receipt:any)=>receipt.results.filter((x:any)=>x.itemInstanceId===R).map((x:any)=>[x.step,x.outcome])

test('方法绑定：关联连接仍待本人授权时，已就绪的方法照样按实际原生名绑定，员工保持暂停、不上岗',async()=>{
 const w=world({skillPreinstalled:true,s1Trust:null,roleNeedsConnector:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(roleResults(receipt),[['role','done'],['role-resume','skipped']])
 const record=w.record()!
 assert.deepEqual([record.version,record.state,record.skills],[2,'paused',[NATIVE]],'methods are bound even though the connection still needs authorization')
 assert.equal(w.writes().some(([endpoint])=>endpoint==='roles/lifecycle'),false)
})

test('方法绑定：本人事先显式安装（非一键）的原方法同样绑定到新员工，安装、来源与原记录都不改',async()=>{
 const w=world({skillPreinstalled:true,s1Trust:null}),r:any=await w.handler('industry-loads/readiness',{loadId})
 assert.deepEqual([byId(r,S1).state,byId(r,R).state],['ready','auto'])
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(endpoints(w),['industry-knowledge/instantiate','industry-mcp-connections/instantiate','industry-roles/instantiate','roles/edit','roles/lifecycle'])
 assert.deepEqual(roleResults(receipt),[['role','done'],['role-resume','done']])
 const record=w.record()!
 assert.deepEqual([record.id,record.version,record.state,record.skills],[ROLE,3,'active',[NATIVE]])
 assert.deepEqual({...record,skills:[],version:1,state:'paused'},roleRecord(1,'paused'),'除方法外的员工定义原样保留')
 assert.equal(w.calls.some(([endpoint])=>endpoint==='skill-installations/install'),false,'不静默安装')
})

test('方法绑定：绑定前复核失败（遮蔽、停用、缺失、替换、撤销、来源不属于该方案、关联漂移）——不保存、不上岗，返回明确缺项',async()=>{
 const cases:[string,Options,RegExp][]=[
  ['同名遮蔽',{bindObserve:'shadowed'},/告警分诊.*同名/],
  ['已停用',{bindObserve:'disabled'},/告警分诊.*停用/],
  ['未找到',{bindObserve:'missing'},/告警分诊.*未找到/],
  ['正文被替换',{bindReplaced:true},/告警分诊.*替换/],
  ['安装已撤销',{bindRevoked:true},/告警分诊.*(未安装|撤销)/],
  ['来源不属于该方案',{atomicSource:true},/告警分诊.*来源/],
  ['方案关联漂移',{mappingDrift:true},/关联已变化/],
 ]
 for(const [label,options,pattern] of cases){
  const w=world({skillPreinstalled:true,s1Trust:null,...options}),r:any=await w.handler('industry-loads/readiness',{loadId})
  const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
  assert.deepEqual(roleResults(receipt),[['role','done'],['role-resume','skipped']],label)
  const resume=receipt.results.find((x:any)=>x.step==='role-resume')
  assert.match(resume.message,pattern,label);assert.match(resume.message,/保持暂停/,label)
  assert.equal(endpoints(w).some(endpoint=>endpoint==='roles/edit'||endpoint==='roles/lifecycle'),false,label)
  assert.deepEqual([w.record()!.version,w.record()!.state,w.record()!.skills],[1,'paused',[]],label)
  if(receipt.readiness)assert.equal(byId(receipt.readiness,R).entry,'role-resume',label)
 }
})

test('方法绑定：本人在创建后已改过的员工（不再是首建 v1）不覆盖、不上岗',async()=>{
 const w=world({skillPreinstalled:true,s1Trust:null,roleEditedByUser:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(roleResults(receipt),[['role','done'],['role-resume','skipped']])
 assert.match(receipt.results.find((x:any)=>x.step==='role-resume').message,/已被修改/)
 assert.equal(endpoints(w).some(endpoint=>endpoint==='roles/edit'||endpoint==='roles/lifecycle'),false)
 assert.deepEqual([w.record()!.version,w.record()!.duty,w.record()!.skills],[2,'本人改过的职责。',[]])
})

test('方法绑定：保存冲突如实失败不上岗；保存后上岗失败保留已绑方法、交本人恢复且不重复绑定',async()=>{
 const conflict=world({skillPreinstalled:true,s1Trust:null,editFails:true}),a:any=await conflict.handler('industry-loads/readiness',{loadId})
 const failed:any=await conflict.handler('industry-loads/prepare',{loadId,expectedDigest:a.digest})
 const resume=failed.results.find((x:any)=>x.step==='role-resume')
 assert.deepEqual([resume.outcome,resume.code],['failed','teloa/version-conflict'])
 assert.equal(endpoints(conflict).includes('roles/lifecycle'),false);assert.deepEqual(conflict.record()!.skills,[])
 const stuck=world({skillPreinstalled:true,s1Trust:null,lifecycleFails:true}),b:any=await stuck.handler('industry-loads/readiness',{loadId})
 const partial:any=await stuck.handler('industry-loads/prepare',{loadId,expectedDigest:b.digest})
 assert.deepEqual(roleResults(partial),[['role','done'],['role-resume','failed']])
 assert.deepEqual([stuck.record()!.version,stuck.record()!.state,stuck.record()!.skills],[2,'paused',[NATIVE]])
 assert.equal(byId(partial.readiness,R).entry,'role-resume')
 await assert.rejects(stuck.handler('industry-loads/prepare',{loadId,expectedDigest:b.digest}),/状态已变化/)
 assert.equal(endpoints(stuck).filter(endpoint=>endpoint==='roles/edit').length,1)
})

test('方法绑定：未接入原员工保存端口时不让空方法员工上岗；没有关联方法的员工照常按 v1 上岗',async()=>{
 const missing=world({skillPreinstalled:true,s1Trust:null,noRoleRecords:true}),a:any=await missing.handler('industry-loads/readiness',{loadId})
 const receipt:any=await missing.handler('industry-loads/prepare',{loadId,expectedDigest:a.digest})
 assert.deepEqual(roleResults(receipt),[['role','done'],['role-resume','skipped']])
 assert.match(receipt.results.find((x:any)=>x.step==='role-resume').message,/方法绑定服务未接入/)
 assert.equal(endpoints(missing).includes('roles/lifecycle'),false)
 const plain=world({noRoleSkill:true}),b:any=await plain.handler('industry-loads/readiness',{loadId})
 await plain.handler('industry-loads/prepare',{loadId,expectedDigest:b.digest})
 assert.equal(plain.calls.some(([endpoint])=>endpoint==='roles/list'||endpoint==='roles/edit'),false)
 assert.deepEqual(plain.writes().find(([endpoint])=>endpoint==='roles/lifecycle')![1],{roleId:ROLE,expectedVersion:1,action:'resume',reason:'方案一键准备'})
})

// ---- 安装身份：摘要固定已装方法的安装 ID、版本、规范来源与正文；绑定前按同一 usage 与方案固定引用重核
test('安装身份入摘要：确认摘要后 usage 迁到另一份同版本安装（公共或自装来源），旧摘要不可借用、一笔不写',async()=>{
 for(const [label,options] of [['公共来源',{}],['自装来源',{localSkill:true}]] as [string,Options][]){
  const w=world({skillPreinstalled:true,s1Trust:null,...options}),r:any=await w.handler('industry-loads/readiness',{loadId})
  w.migrate()
  const migrated:any=await w.handler('industry-loads/readiness',{loadId})
  assert.notEqual(migrated.digest,r.digest,label)
  await assert.rejects(w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest}),/状态已变化/,label)
  assert.equal(w.writes().length,0,label)
 }
})

test('安装身份：绑定前 usage 迁到另一份同版本安装（公共或自装来源）——不绑定、不上岗，返回明确缺项',async()=>{
 for(const [label,options] of [['公共来源',{skillPreinstalled:true,s1Trust:null,bindMigrated:true}],['自装来源',{skillPreinstalled:true,s1Trust:null,bindMigrated:true,localSkill:true}],['本次一键安装后被迁走',{bindMigrated:true}]] as [string,Options][]){
  const w=world(options),r:any=await w.handler('industry-loads/readiness',{loadId})
  const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
  assert.deepEqual(roleResults(receipt),[['role','done'],['role-resume','skipped']],label)
  assert.match(receipt.results.find((x:any)=>x.step==='role-resume').message,/告警分诊.*确认后已变化/,label)
  assert.equal(endpoints(w).some(endpoint=>endpoint==='roles/edit'||endpoint==='roles/lifecycle'),false,label)
  assert.deepEqual([w.record()!.version,w.record()!.skills],[1,[]],label)
 }
})

test('安装来源：同名同正文但来自另一公共来源的安装，即使按新摘要确认也不绑定、不上岗，且不重新安装',async()=>{
 const w=world({skillPreinstalled:true,s1Trust:null,foreignPublic:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(roleResults(receipt),[['role','done'],['role-resume','skipped']])
 assert.match(receipt.results.find((x:any)=>x.step==='role-resume').message,/告警分诊.*固定来源/)
 assert.equal(endpoints(w).some(endpoint=>endpoint==='roles/edit'||endpoint==='roles/lifecycle'||endpoint==='skill-installations/install'),false)
 assert.deepEqual([w.record()!.version,w.record()!.skills],[1,[]])
})

test('安装来源：同一真正公共来源（首次安装来自另一加载）与严格核对的自装来源都绑定成功；只读预览、不重新安装',async()=>{
 for(const [label,options] of [['公共来源复用首次另一加载',{}],['本加载自装来源',{localSkill:true}]] as [string,Options][]){
  const w=world({skillPreinstalled:true,s1Trust:null,...options}),r:any=await w.handler('industry-loads/readiness',{loadId})
  const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
  assert.deepEqual(roleResults(receipt),[['role','done'],['role-resume','done']],label)
  assert.deepEqual(w.record()!.skills,[NATIVE],label)
  assert.ok(w.calls.some(([endpoint,payload])=>endpoint==='skill-installations/preview'&&JSON.stringify(payload)===JSON.stringify({source:{kind:'industry',loadId,itemInstanceId:S1}})),label)
  assert.equal(w.calls.some(([endpoint])=>endpoint==='skill-installations/install'),false,label)
 }
})

// ---- 依赖应用（扩展）：已核验的随一键安装并启用；需要本人授权、无法核验、待重启或失败的给出原因与下一步 ----
test('readiness：依赖应用按实例真实状态分类，未登记、待安装、待启用可一键；待重启与失败归需要你操作并带原因',async()=>{
 const row=async(pluginState:string|null)=>byId(await world({pluginState,roleNeedsPlugin:true}).handler('industry-loads/readiness',{loadId}),G)
 for(const state of [null,'needs_install','pending-enable']){const r=await row(state);assert.deepEqual([r.state,r.step,r.entry],['auto','plugin',null],String(state))}
 assert.equal((await row('installing')).state,'pending')
 assert.equal((await row('active')).state,'ready')
 for(const state of ['restart-required','failed']){const r=await row(state);assert.deepEqual([r.state,r.entry,r.reason],['needs-user','plugin',state])}
 // 应用行带方案固定版本；已登记时带 npm 包名，确认卡据此逐项列出
 assert.deepEqual((await row(null)).app,{version:'1.0.0',packageName:null})
 assert.deepEqual((await row('needs_install')).app,{version:'1.0.0',packageName:'@example/ticket'})
})

test('prepare：未被任何员工依赖的应用条目不随一键安装，照旧归需要你操作',async()=>{
 const w=world({pluginState:null}),r:any=await w.handler('industry-loads/readiness',{loadId})
 assert.deepEqual([byId(r,G).state,byId(r,G).step,byId(r,G).entry,byId(r,G).reason],['needs-user',null,'plugin',undefined])
 await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.ok(!w.writes().some(([endpoint])=>endpoint.startsWith('industry-plugins/')))
})

test('prepare：已核验的依赖应用经原扩展接口登记→安装→启用，子请求 id 由宿主派生；就绪后员工照常上岗',async()=>{
 const w=world({pluginState:null,roleNeedsPlugin:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.deepEqual(w.writes().map(([endpoint])=>endpoint),['industry-knowledge/instantiate','skill-installations/install','industry-mcp-connections/instantiate','industry-plugins/instantiate','industry-plugins/install','industry-plugins/enable','industry-roles/instantiate','roles/edit','roles/lifecycle'])
 const payload=(endpoint:string)=>w.writes().find(([e])=>e===endpoint)![1]
 assert.deepEqual(payload('industry-plugins/instantiate'),{requestId:prepareRequestId(owner,loadId,G,'plugin',r.digest),loadId,itemInstanceId:G})
 assert.deepEqual(payload('industry-plugins/install'),{requestId:prepareRequestId(owner,loadId,G,'plugin-install',r.digest),instanceId:PI,expectedRevision:1,preview:pluginPreview('verified')})
 assert.deepEqual(payload('industry-plugins/enable'),{instanceId:PI,preview:pluginPreview('verified')})
 assert.deepEqual(receipt.results.filter((x:any)=>x.itemInstanceId===G).map((x:any)=>[x.step,x.outcome]),[['plugin','done']])
 assert.equal(byId(receipt.readiness,G).state,'ready')
 assert.deepEqual(receipt.results.find((x:any)=>x.step==='role-resume').outcome,'done')
})

test('prepare：需要本人授权或无法核验的应用不安装，给出原因与下一步并归需要你操作；员工保持暂停，不再列为可一键',async()=>{
 for(const [trust,reason,pattern] of [['unverified','unverified',/查看.*权限/],['rejected','rejected',/不能安装/]] as const){
  const w=world({pluginState:null,pluginTrust:trust,roleNeedsPlugin:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
  const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
  assert.ok(!w.writes().some(([endpoint])=>endpoint==='industry-plugins/install'||endpoint==='industry-plugins/enable'),trust)
  const result=receipt.results.find((x:any)=>x.itemInstanceId===G)
  assert.equal(result.outcome,'skipped');assert.match(result.message,pattern)
  assert.deepEqual([byId(receipt.readiness,G).state,byId(receipt.readiness,G).reason],['needs-user',reason])
  assert.equal(receipt.results.find((x:any)=>x.step==='role-resume').outcome,'skipped')
  assert.ok(!w.writes().some(([endpoint])=>endpoint==='roles/lifecycle'))
 }
})

test('prepare：应用启用后待重启时如实说明，员工保持暂停；预览失败按失败返回，下次一键可重试',async()=>{
 const w=world({pluginState:'pending-enable',pluginEnableTo:'restart-required',roleNeedsPlugin:true}),r:any=await w.handler('industry-loads/readiness',{loadId})
 const receipt:any=await w.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.ok(!w.writes().some(([endpoint])=>endpoint==='industry-plugins/install'),'待启用的应用只启用不重装')
 const result=receipt.results.find((x:any)=>x.itemInstanceId===G)
 assert.equal(result.outcome,'skipped');assert.match(result.message,/重启/)
 assert.deepEqual([byId(receipt.readiness,G).state,byId(receipt.readiness,G).reason],['needs-user','restart-required'])
 assert.ok(!w.writes().some(([endpoint])=>endpoint==='roles/lifecycle'))
 const f=world({pluginState:'needs_install',pluginPreviewFails:true,roleNeedsPlugin:true}),fr:any=await f.handler('industry-loads/readiness',{loadId})
 const failed:any=await f.handler('industry-loads/prepare',{loadId,expectedDigest:fr.digest})
 assert.deepEqual(failed.results.filter((x:any)=>x.itemInstanceId===G).map((x:any)=>[x.step,x.outcome,x.code]),[['plugin','failed','teloa/dependency-unavailable']])
 assert.equal(byId(failed.readiness,G).state,'auto')
})


test('升级沿用的员工与资料按 carriedFrom 读取真实准备状态，不创建第二份对象',async()=>{
 const w=world({rolePaused:true,noRoleSkill:true})
 const original=w.ports.loads
 w.ports.loads=async(endpoint,payload,signal)=>{
  const load=await original(endpoint,payload,signal) as Record<string,any>
  return {...load,items:load.items.map((item:any)=>item.instanceId===R?{...item,instanceId:'f1111111-1111-4111-8111-111111111111',carriedFrom:R}:item.instanceId===K?{...item,instanceId:'f2222222-2222-4222-8222-222222222222',carriedFrom:K}:item)}
 }
 const knowledge=w.ports.knowledge
 w.ports.knowledge=async(endpoint,payload,signal)=>endpoint==='industry-knowledge/list'?{items:[{loadId:otherLoad,itemInstanceId:K,state:'active',revision:2}]}:knowledge(endpoint,payload,signal)
 const roles=w.ports.roles
 w.ports.roles=async(endpoint,payload,signal)=>{
  const result=await roles(endpoint,payload,signal) as any
  return endpoint==='industry-roles/list'?{items:result.items.map((row:any)=>({...row,loadId:otherLoad}))}:result
 }
 const handler=createIndustryPrepareHandler(owner,async()=>w.ports)
 const ready=await handler('industry-loads/readiness',{loadId}) as any
 assert.equal(ready.rows.find((row:any)=>row.itemInstanceId==='f2222222-2222-4222-8222-222222222222').state,'ready')
 assert.equal(ready.rows.find((row:any)=>row.itemInstanceId==='f1111111-1111-4111-8111-111111111111').entry,'role-resume')
 assert.equal(w.calls.filter(([endpoint])=>endpoint.endsWith('/instantiate')).length,0)
})

function unlinkedLocalMethod(change?:(row:Record<string,any>)=>Record<string,any>,observed='available'){
 const w=world({skillPreinstalled:true,localSkill:true,s1Trust:null,rolePaused:true,noRoleSkill:true,observeState:observed})
 const original=w.ports.skills;let linked=false
 w.ports.skills=async(endpoint,payload,signal)=>{
  const result=await original(endpoint,payload,signal) as Record<string,any>
  if(endpoint!=='skill-installations/list')return result
  const row={...result.items[0],source:{...result.items[0].source,loadId:otherLoad,contentId:'c8888888-0000-4000-8000-000000000000',contentHash:hex('9')}}
  return {items:[change?change(row):row],usages:[{loadId:linked?loadId:otherLoad,itemInstanceId:S1,installationId:INST}]}
 }
 return {...w,handler:createIndustryPrepareHandler(owner,async()=>w.ports),link:()=>{linked=true}}
}

test('升级未变本地方法识别旧安装，仍需本人关联当前加载；只读观测不安装也不自动计就绪',async()=>{
 const w=unlinkedLocalMethod(),before=await w.handler('industry-loads/readiness',{loadId}) as any
 assert.deepEqual([byId(before,S1).state,byId(before,S1).entry],['needs-user','skill-link'])
 assert.ok(w.calls.some(([endpoint,payload])=>endpoint==='skill-installations/observe'&&payload.installationId===INST))
 await w.handler('industry-loads/prepare',{loadId,expectedDigest:before.digest})
 assert.equal(w.calls.some(([endpoint])=>endpoint==='skill-installations/install'),false,'一键准备不能替代本人沿用确认')
 w.link()
 const after=await w.handler('industry-loads/readiness',{loadId}) as any
 assert.equal(byId(after,S1).state,'ready')
 assert.notEqual(after.digest,before.digest)
})

test('已有相同安装但工作区停用、缺失、遮蔽或观测失败仍不能计就绪',async()=>{
 for(const state of ['disabled','missing','shadowed','unknown']){
  const w=unlinkedLocalMethod(undefined,state),ready=await w.handler('industry-loads/readiness',{loadId}) as any
  assert.deepEqual([byId(ready,S1).state,byId(ready,S1).entry],['needs-user','skill-link'],state)
  assert.equal(w.calls.some(([endpoint])=>endpoint==='skill-installations/install'),false,state)
 }
})

test('跨包方法识别不放宽文件、信任、资源版本或任一原生元数据校验',async()=>{
 const changes=[
  (row:Record<string,any>)=>({...row,bundleHash:hex('6')}),
  (row:Record<string,any>)=>({...row,trustHash:hex('6')}),
  (row:Record<string,any>)=>({...row,source:{...row.source,resourceVersion:'2.0.0'}}),
  ...['name','description','bodyHash','modelInvocable','userInvocable'].map(key=>(row:Record<string,any>)=>({...row,native:{...row.native,[key]:typeof row.native[key]==='boolean'?!row.native[key]:'changed'}})),
 ]
 for(const change of changes){
  const w=unlinkedLocalMethod(change),ready=await w.handler('industry-loads/readiness',{loadId}) as any
  assert.deepEqual([byId(ready,S1).state,byId(ready,S1).entry],['needs-user','skill-confirm'])
  assert.equal(w.calls.some(([endpoint])=>endpoint==='skill-installations/install'),false)
 }
})
