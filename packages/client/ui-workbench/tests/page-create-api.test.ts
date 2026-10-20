import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
import {pageCreateEntities,type PageCreateEntity} from '@teloa/contract'
import {createConfirmGuard,createConsequenceKey,createDraftRows,createFailureKey,createOptions,createPlaceholderKey,createRoleFormInitial,createSentencePrompt} from '../src/client/page-create-presentation.ts'
import {PAGE_CREATE_MESSAGE_ROWS} from '../src/client/i18n/locales/page-create.ts'

registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {createPageCreateApi,readPageCreateDraftDirectory,readPageCreateDraftPreview}=await import('../src/client/page-create-api.ts')
const {pageCreateDraftRevisionNavigation}=await import('../src/client/page-create-revision-context.ts')
const {BindingClient}=await import('../src/client/binding-client.ts')
const {createWorkbenchStore}=await import('../src/client/store.ts')
const {createWorkbenchLayout}=await import('../src/client/workbench-layout.ts')
const {createSettingsNavigation}=await import('../src/client/settings-navigation.ts')
const {homeCreationLocation}=await import('../src/client/home-creation-navigation.ts')

const stamp='2026-09-17T01:00:00.000Z'
const bodyHash='a'.repeat(64)
const roleBody={name:'对账',kind:'employee',scopes:['SOC'],duty:'核对账单',dataScope:'已授权账单',executionScope:'仅核对',skills:[],knowledge:[],responsibility:{triggers:['每日'],autonomousActions:['核对'],confirmationPoints:['外发'],escalationRules:['失败'],deliveryChecks:['完整']}}
const dict=new Map(PAGE_CREATE_MESSAGE_ROWS.map(row=>[row[0] as string,row[1] as string]))
const t=((key:string,params?:Record<string,string|number>)=>{
 const value=dict.get(key)??key
 return value.replace(/\{(\w+)\}/g,(_,name:string)=>String(params?.[name]??''))
}) as never

const draft=(patch:Record<string,unknown>={}):Record<string,unknown>=>({
 id:'draft-1',ownerId:'local:teloa-owner',requestId:'req-1',entity:'role',
 body:JSON.stringify(roleBody),bodyHash,title:'每天对账的同事',
 status:'draft',createdAt:stamp,updatedAt:stamp,...patch,
})
const directory=(patch:Record<string,unknown>={}):Record<string,unknown>=>({
 schema:'teloa.page-create-drafts/v1',entity:'role',readAt:stamp,drafts:[draft()],...patch,
})
const preview=(patch:Record<string,unknown>={}):Record<string,unknown>=>({
 schema:'teloa.page-create-draft-preview/v1',draft:draft(),
 fields:[{path:'name',value:'"对账"'}],fieldsTruncated:false,
 consequences:[{kind:'impact',id:'roles',required:true}],
 next:{endpoint:'roles/create',consentKeys:['create.consequence.credential']},
 computedAt:stamp,...patch,
})

function recorder(reply:(method:string,payload:unknown)=>unknown){
 const calls:Array<{method:string;payload:unknown}>=[]
 const api=createPageCreateApi(async(method,payload)=>{calls.push({method,payload});return reply(method,payload)})
 return {api,calls}
}

test('三选可用性矩阵：各实体 × hasForm/hasMarket 的组合逐格对得上，不摆必然被拒的按钮',()=>{
 const grid=pageCreateEntities.flatMap(entity=>[[false,false],[true,false],[false,true],[true,true]].map(([hasForm,hasMarket])=>
  [entity+'/'+String(hasForm)+'/'+String(hasMarket),createOptions({entity,hasForm:hasForm!,hasMarket:hasMarket!}).join('+')] as const))
 assert.deepEqual(Object.fromEntries(grid),{
  // 业务声明那一支三项都可用（既有表单是第二期的定制面板）。
  'business-definition/false/false':'sentence','business-definition/true/false':'sentence+form',
  'business-definition/false/true':'sentence+market','business-definition/true/true':'sentence+form+market',
  // 业务台账首页今天没有手填业务的表单：给了 openForm 也不摆「自己填」（规格 §七）。
  'business-domain/false/false':'sentence','business-domain/true/false':'sentence',
  'business-domain/false/true':'sentence+market','business-domain/true/true':'sentence+market',
  'role/false/false':'sentence','role/true/false':'sentence+form',
  'role/false/true':'sentence+market','role/true/true':'sentence+form+market',
  'skill/false/false':'sentence','skill/true/false':'sentence+form',
  'skill/false/true':'sentence+market','skill/true/true':'sentence+form+market',
  'connector/false/false':'sentence','connector/true/false':'sentence+form',
  'connector/false/true':'sentence+market','connector/true/true':'sentence+form+market',
  // 扩展没有手填表单；白名单已清空（产品底座只用官方插件，无第三方扩展在架），
  // 「用一句话描述」没有落点故不出现，只剩「去市场挑」。
  'extension/false/false':'','extension/true/false':'',
  'extension/false/true':'market','extension/true/true':'market',
  // 模板由会话生成静态组成，不增加一套手填大表单。
  'share/false/false':'sentence','share/true/false':'sentence',
  'share/false/true':'sentence+market','share/true/true':'sentence+market',
  'plan/false/false':'sentence','plan/true/false':'sentence+form',
  'plan/false/true':'sentence+market','plan/true/true':'sentence+form+market',
  'app/false/false':'sentence','app/true/false':'sentence+form',
  'app/false/true':'sentence+market','app/true/true':'sentence+form+market',
 })
})

test('占位文案与三类后果都按固定词条键选，两支业务共用同一条',()=>{
 assert.equal(createPlaceholderKey('business-definition'),'create.sentence.placeholder.business')
 assert.equal(createPlaceholderKey('business-domain'),'create.sentence.placeholder.business')
 assert.equal(createPlaceholderKey('connector'),'create.sentence.placeholder.connector')
 assert.equal(createConsequenceKey('credential'),'create.consequence.credential')
 assert.equal(createConsequenceKey('egress'),'create.consequence.egress')
})

test('未预览时没有确认；预览读到之后才有，且入参逐字取预览回包里的 bodyHash',()=>{
 assert.deepEqual(createConfirmGuard(undefined),{ok:false,reason:'not-previewed'})
 const settled=readPageCreateDraftPreview(preview({draft:draft({status:'applied',appliedRef:'role-9'})}))
 assert.deepEqual(createConfirmGuard(settled),{ok:false,reason:'already-settled'})
 const guard=createConfirmGuard(readPageCreateDraftPreview(preview()))
 assert.deepEqual(guard,{ok:true,expectedBodyHash:bodyHash,next:'roles/create'})
})

test('目录行按状态选词条，标题逐字取草案自带的那一句',()=>{
 const rows=createDraftRows(readPageCreateDraftDirectory(directory({drafts:[
  draft(),draft({id:'draft-2',status:'applied',appliedRef:'role-9'}),draft({id:'draft-3',status:'discarded'}),
 ]})))
 assert.deepEqual(rows.map(row=>[row.draftId,row.titleKey,row.pending]),[
  ['draft-1','create.draft.pending',true],
  ['draft-2','create.draft.applied',false],
  ['draft-3','create.draft.discarded',false],
 ])
 assert.equal(rows[0]!.title,'每天对账的同事')
})

test('读写失败按错误码选一条固定文案，认不出来的码退回通用那句',()=>{
 assert.equal(createFailureKey({code:'teloa/version-conflict'}),'create.conflict')
 assert.equal(createFailureKey({code:'teloa/conflict'}),'create.conflict')
 assert.equal(createFailureKey({code:'teloa/forbidden'}),'create.forbidden')
 assert.equal(createFailureKey({code:'teloa/storage-corrupt'}),'create.readFailed')
 assert.equal(createFailureKey(Error('形状不一致')),'create.readFailed')
})

test('一句话经 createSentencePrompt 预备进会话：三行固定文案写明实体与业务范围，sourceId 是 entity:scope 复合键，sourceKind 缺省',()=>{
 const prepared=createSentencePrompt('business-definition','SOC','把客户投诉记成一类东西',t)
 assert.equal(prepared.sourceId,'business-definition:SOC')
 assert.ok(!('sourceKind' in prepared))
 assert.equal(prepared.title,dict.get('create.title'))
 // 三行固定文案（实体、业务范围、既有前缀）+ 用户原话逐字，不改写、不拼任何多余标识。
 const businessDefinitionLines=[
  dict.get('create.sentence.prompt.entity')!.replace('{entity}',dict.get('create.entity.businessDefinition')!),
  dict.get('create.sentence.prompt.scope')!.replace('{scope}','SOC'),
  dict.get('create.sentence.prompt')!,
 ]
 assert.equal(prepared.text,businessDefinitionLines.join('\n')+'\n把客户投诉记成一类东西')
 // 有 scope 时含「业务范围是 SOC」，不含「不需要业务范围」。
 assert.match(prepared.text,/业务范围是 SOC/)
 assert.doesNotMatch(prepared.text,/不需要业务范围/)

 const rolePrepared=createSentencePrompt('role',undefined,'  招一个对账的  ',t)
 assert.equal(rolePrepared.sourceId,'role:')
 assert.equal(rolePrepared.text.endsWith('招一个对账的'),true)
 // 无 scope 时含「不需要业务范围」，不含「业务范围是」，且点名了要建的实体（数字员工）。
 assert.match(rolePrepared.text,/不需要业务范围/)
 assert.doesNotMatch(rolePrepared.text,/业务范围是/)
 assert.ok(rolePrepared.text.includes(dict.get('create.entity.role')!))

 assert.throws(()=>createSentencePrompt('role',undefined,'   ',t))
 // 技能一句话新建首行显式调用内置创建器（官方 /名称 手势，宿主注入固定正文），其余三行与原话不变。
 const skillPrepared=createSentencePrompt('skill',undefined,'做一个周报核对技能',t)
 const skillLines=skillPrepared.text.split('\n')
 assert.equal(skillLines[0],'/teloa-skill-creator')
 assert.equal(skillLines.slice(1).join('\n'),[dict.get('create.sentence.prompt.entity')!.replace('{entity}',dict.get('create.entity.skill')!),dict.get('create.sentence.prompt.noScope')!,dict.get('create.sentence.prompt')!].join('\n')+'\n做一个周报核对技能')
 assert.ok(!rolePrepared.text.includes('/teloa-skill-creator')&&!prepared.text.includes('/teloa-skill-creator'))
})

test('数字员工草案只在正文经既有岗位写入判据复核后才能预填三问表单',()=>{
 const value=createRoleFormInitial(readPageCreateDraftPreview(preview()))
 assert.deepEqual(value,roleBody)
 assert.throws(()=>createRoleFormInitial(readPageCreateDraftPreview(preview({draft:draft({entity:'skill'})}))))
 assert.throws(()=>createRoleFormInitial(readPageCreateDraftPreview(preview({draft:draft({body:'{"name":"only"}'})}))))
})

test('三个端点只提交白名单字段，跳过未登记的 general',async()=>{
 const {api,calls}=recorder(()=>directory({entity:'connector',scope:'SOC',drafts:[]}))
 await api.directory({entity:'connector',scope:'SOC'})
 assert.deepEqual(calls,[{method:'page-create-drafts/directory',payload:{entity:'connector',scope:'SOC'}}])
 await assert.rejects(api.directory({entity:'connector',scope:'general'}))
 await assert.rejects(api.directory({entity:'nope' as PageCreateEntity}))
 // 多带的键不往宿主递。
 const extra=recorder(()=>directory())
 await extra.api.directory({entity:'role',...{sneak:'x'}} as {entity:PageCreateEntity})
 assert.deepEqual(extra.calls[0]!.payload,{entity:'role'})
})

test('落定入参：丢弃不带落地物，expectedBodyHash 必须是摘要形态',async()=>{
 const {api,calls}=recorder(()=>directory({drafts:[]}))
 await api.settle({requestId:'req-2',draftId:'draft-1',expectedBodyHash:bodyHash,outcome:'discarded'})
 assert.deepEqual(calls[0],{method:'page-create-drafts/settle',payload:{requestId:'req-2',draftId:'draft-1',expectedBodyHash:bodyHash,outcome:'discarded'}})
 await api.settle({requestId:'req-3',draftId:'draft-1',expectedBodyHash:bodyHash,outcome:'applied',appliedRef:'role-9'})
 assert.deepEqual(calls[1]!.payload,{requestId:'req-3',draftId:'draft-1',expectedBodyHash:bodyHash,outcome:'applied',appliedRef:'role-9'})
 await assert.rejects(api.settle({requestId:'req-4',draftId:'draft-1',expectedBodyHash:bodyHash,outcome:'discarded',appliedRef:'role-9'}))
 await assert.rejects(api.settle({requestId:'req-5',draftId:'draft-1',expectedBodyHash:'zz',outcome:'applied',appliedRef:'role-9'}))
 await assert.rejects(api.preview({draftId:'  '}))
})

test('回包缺键 / schema 不对 → 读取失败，不以空面板替代',()=>{
 assert.equal(readPageCreateDraftDirectory(directory(),{entity:'role'}).drafts.length,1)
 for(const [name,value] of [
  ['schema 不对',directory({schema:'teloa.page-create-drafts/v2'})],
  ['缺 readAt',(()=>{const row=directory();delete row.readAt;return row})()],
  ['多一个没约定的键',directory({extra:1})],
  ['实体与请求不同',directory({entity:'skill'})],
  ['草案混进别的实体',directory({drafts:[draft({entity:'skill'})]})],
  ['草案标识重复',directory({drafts:[draft(),draft()]})],
  ['正文不是 JSON',directory({drafts:[draft({body:'not json'})]})],
  ['摘要不是 64 位',directory({drafts:[draft({bodyHash:'abc'})]})],
  ['draft 带着落地物',directory({drafts:[draft({appliedRef:'role-9'})]})],
  ['general 范围',directory({scope:'general',drafts:[draft({scope:'general'})]})],
 ] as const)assert.throws(()=>readPageCreateDraftDirectory(value as unknown,{entity:'role'}),String(name))
 // 范围要逐字对上：请求 SOC 回了没有 scope 的那份也算读不出来。
 assert.throws(()=>readPageCreateDraftDirectory(directory(),{entity:'role',scope:'SOC'}))
})

test('预览回包逐条核对：三块形状、词条键、与业务那一支的归属',()=>{
 const read=readPageCreateDraftPreview(preview())
 assert.deepEqual(read.fields,[{path:'name',value:'"对账"'}])
 assert.deepEqual(read.consequences,[{kind:'impact',id:'roles',required:true}])
 assert.deepEqual(read.next,{endpoint:'roles/create',consentKeys:['create.consequence.credential']})
 for(const [name,value] of [
  ['schema 不对',preview({schema:'x'})],
  ['缺 next',(()=>{const row=preview();delete row.next;return row})()],
  ['后果类别不在四类里',preview({consequences:[{kind:'other',id:'x',required:false}]})],
  ['端点名不是逐字形态',preview({next:{endpoint:'Roles Create',consentKeys:[]}})],
  ['consentKeys 混了自由文本',preview({next:{endpoint:'roles/create',consentKeys:['请同意它']}})],
  ['字段路径重复',preview({fields:[{path:'name',value:'"a"'},{path:'name',value:'"b"'}]})],
  ['非业务支带了第二期预览',preview({businessPreview:{schema:'teloa.business-definition-preview/v1'}})],
 ] as const)assert.throws(()=>readPageCreateDraftPreview(value as unknown),String(name))
 // 第二期读取器尚未装配，不能把只有 schema 的对象强转为可确认的预览。
 assert.throws(()=>readPageCreateDraftPreview(preview({businessPreview:{schema:'teloa.business-definition-preview/v1',diff:[]}})))
})

test('正文必须通过实体的既有判据，合法 JSON 但字段缺失也拒收',()=>{
 assert.throws(()=>readPageCreateDraftDirectory(directory({drafts:[draft({body:'{"name":"对账"}'})]})),{code:'teloa/invalid-host-response'})
 assert.throws(()=>readPageCreateDraftDirectory(directory({entity:'skill',drafts:[draft({entity:'skill',body:'{}'})]})),{code:'teloa/invalid-host-response'})
})

test('预览身份必须与请求逐字相同，取消信号透传三个端点',async()=>{
 const controller=new AbortController()
 const calls:string[]=[]
 const api=createPageCreateApi(async(method,_payload,signal)=>{
  assert.equal(signal,controller.signal)
  calls.push(method)
  return method.endsWith('/preview')?preview():directory()
 })
 await api.directory({entity:'role'},controller.signal)
 await api.preview({draftId:'draft-1'},controller.signal)
 await api.settle({requestId:'req-discard',draftId:'draft-1',outcome:'discarded',expectedBodyHash:bodyHash},controller.signal)
 await assert.rejects(api.preview({draftId:'another-draft'},controller.signal),{code:'teloa/invalid-host-response'})
 assert.equal(calls.length,4)
})

test('回原会话只提交原稿与摘要，逐字核对只读回包并透传取消',async()=>{
 const controller=new AbortController(),calls:unknown[]=[]
 const api=createPageCreateApi(async(method,payload,signal)=>{assert.equal(signal,controller.signal);calls.push({method,payload});return {draftId:'draft-1',bodyHash,sessionId:'original-chat'}})
 assert.deepEqual(await api.origin({draftId:'draft-1',expectedBodyHash:bodyHash,...{ownerId:'forged'}},controller.signal),{draftId:'draft-1',bodyHash,sessionId:'original-chat'})
 assert.deepEqual(calls,[{method:'page-create-drafts/origin',payload:{draftId:'draft-1',expectedBodyHash:bodyHash}}])
 for(const value of [
  {draftId:'someone-else',bodyHash,sessionId:'original-chat'},
  {draftId:'draft-1',bodyHash:'b'.repeat(64),sessionId:'original-chat'},
  {draftId:'draft-1',bodyHash,sessionId:'../other'},
  {draftId:'draft-1',bodyHash,sessionId:'original-chat',text:'must-not-inject'},
 ])await assert.rejects(createPageCreateApi(async()=>value).origin({draftId:'draft-1',expectedBodyHash:bodyHash}),{code:'teloa/invalid-host-response'})
 await assert.rejects(api.origin({draftId:'draft-1',expectedBodyHash:'stale'},controller.signal))
 assert.equal(calls.length,1)
})

async function revisionNavigationFixture(initial='original-chat'){
 const store=createWorkbenchStore().create(),settings=createSettingsNavigation(),controller=new AbortController(),target='original-chat',opened:string[]=[]
 const layout=createWorkbenchLayout(store.actions,()=>false,settings,{getSnapshot:()=>store.getSnapshot().panelInfo,subscribe:listener=>store.subscribe(listener)})
 let selected:string|undefined=initial,current=true,afterCommit=()=>{}
 const conversation:import('@teloa/contract').Conversation={id:'original-binding',ownerId:'local:owner',title:'原创建会话',scopeIds:['general'],version:1,status:'ready',sessionId:target,requestedSessionId:target,createdAt:stamp}
 const port:import('../src/client/binding-client.ts').WorkPort={list:async()=>[conversation],read:async()=>conversation,ensure:async id=>({...conversation,...(id===target?{}:{id:'other-binding',sessionId:id,requestedSessionId:id})}),isNativeChild:()=>false,catalog:async()=>{throw Error('不读取能力')},block:()=>{},create:async()=>{throw Error('不能新建')},adopt:async id=>id,current:()=>selected,open:id=>{selected=id;opened.push(id);layout.selectPanel(null);afterCommit()}}
 const work=new BindingClient(port);await work.select(initial);store.actions.openAttention()
 const navigation=pageCreateDraftRevisionNavigation({cancelSignal:controller.signal,navigationSignal:layout.beginNavigation(),current:()=>current,location:()=>homeCreationLocation(store.getSnapshot()),isNativeConversation:()=>store.getSnapshot().view==='messages'&&store.getSnapshot().messageMode==='native',mainSession:()=>selected,boundSession:()=>work.getSnapshot().sessionId})
 return {store,layout,work,port,target,navigation,controller,opened,conversation,changeConnection:()=>current=false,selectOther:()=>selected='other-chat',afterCommit:(action:()=>void)=>afterCommit=action}
}
test('原稿导航在真实layout和BindingClient成功打开后自abort，仍保留原会话准备资格',async()=>{
 for(const initial of ['original-chat','other-chat']){
  const f=await revisionNavigationFixture(initial)
  try{
   assert.equal(f.work.getSnapshot().sessionId,initial);assert.equal(f.navigation.mayOpen(),true)
   assert.equal(await f.work.openSessionResult(f.target,f.navigation.signal,f.navigation.mayOpen),'opened')
   assert.equal(f.navigation.signal.aborted,true,'正式layout.selectPanel(null)必须真的撤销导航信号')
   assert.deepEqual(f.opened,[f.target]);assert.equal(f.store.getSnapshot().view,'messages')
   assert.equal(f.navigation.isOpened(f.target),true,'成功提交后改用本人取消、连接和双会话身份核对')
   assert.equal(f.navigation.isOpened('other-chat'),false)
  }finally{f.layout.dispose()}
 }
})
test('原稿导航仍拒绝打开前后本人取消、其他目标导航与连接换代',async()=>{
 for(const when of ['before','after'])for(const change of ['cancel','location','connection','session']){
  const f=await revisionNavigationFixture()
  const mutate=()=>{if(change==='cancel')f.controller.abort();else if(change==='location')f.store.actions.navigate('projects');else if(change==='connection')f.changeConnection();else f.selectOther()}
  try{
   if(when==='before'){
    let release!:(value:typeof f.conversation)=>void;f.port.read=()=>new Promise(resolve=>release=resolve)
    const pending=f.work.openSessionResult(f.target,f.navigation.signal,f.navigation.mayOpen);mutate();release(f.conversation)
    assert.equal(await pending,'cancelled',change);assert.deepEqual(f.opened,[])
   }else{
    f.afterCommit(mutate)
    assert.equal(await f.work.openSessionResult(f.target,f.navigation.signal,f.navigation.mayOpen),'opened',change);assert.deepEqual(f.opened,[f.target])
   }
   assert.equal(f.navigation.isOpened(f.target),false,when+' '+change)
  }finally{f.layout.dispose()}
 }
})

test('预览文件正文超过 8192 字但未到正文上限时仍完整保留',()=>{
 const value=JSON.stringify('长'.repeat(9000))
 assert.equal(readPageCreateDraftPreview(preview({fields:[{path:'text',value}]})).fields[0]!.value,value)
})

test('未知同意词条拒收，避免界面只剩内部键名而仍允许确认',()=>{
 assert.throws(()=>readPageCreateDraftPreview(preview({next:{endpoint:'roles/create',consentKeys:['create.nonexistent']}})),{code:'teloa/invalid-host-response'})
})

test('业务声明缺少第二期预览，或未装配第二期读取器时，一律拒收',()=>{
 const body={format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警单',unit:'条',lead:'待处置告警',sourceId:'soc-alerts',fields:[{name:'severity',label:'级别',type:'enum',required:true,from:'级别',values:['高','低']}]}
 const row=preview({draft:draft({entity:'business-definition',scope:'SOC',body:JSON.stringify(body)}),next:{endpoint:'business-definitions/apply',consentKeys:[]}})
 assert.throws(()=>readPageCreateDraftPreview(row),{code:'teloa/invalid-host-response'})
 assert.throws(()=>readPageCreateDraftPreview({...row,businessPreview:{schema:'teloa.business-definition-preview/v1'}}),{code:'teloa/invalid-host-response'})
 let delegated=false
 assert.throws(()=>readPageCreateDraftPreview({...row,businessPreview:{schema:'teloa.business-definition-preview/v1'}},{businessPreview:()=>{delegated=true;throw Error('第二期逐字段校验失败')}}),{code:'teloa/invalid-host-response'})
 assert.equal(delegated,true)
})
