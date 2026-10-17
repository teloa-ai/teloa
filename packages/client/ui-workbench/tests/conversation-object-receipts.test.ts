import {test} from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
registerHooks({resolve(specifier,context,next){if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)}return next(specifier,context)}})
const {conversationObjectReceipt,conversationTurnObjectReceipts,readConversationIndustrySkillDetail}=await import('../src/client/conversation-object-receipts.ts')
const role={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:teloa-owner',version:1,state:'active',createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z',name:'小研',kind:'employee',scopes:['general'],duty:'整理资料',dataScope:'已授权资料',executionScope:'分析',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},avatarKey:'general'}
const receipt={schema:'teloa.employee-result/v1',operation:'create',sessionId:'source',role}
const entries=[{event:{type:'tool/call',seq:1,data:{turn:1,name:'teloa_employees_create',callId:'call'}}},{event:{type:'tool/result',seq:2,data:{turn:1,message:{toolCallId:'call',content:[{type:'text',text:JSON.stringify(receipt)}]}}}}]
test('仅匹配当前轮成功工具回执，助手文字、其他轮与错误不能生成对象入口',()=>{
 assert.deepEqual(conversationTurnObjectReceipts(entries,1).map(row=>[row.kind,row.id]),[['role',role.id]])
 assert.deepEqual(conversationTurnObjectReceipts(entries,2),[])
 assert.deepEqual(conversationTurnObjectReceipts([entries[1]!],1),[])
 assert.deepEqual(conversationTurnObjectReceipts([entries[0]!,{event:{type:'tool/result',seq:2,data:{turn:1,message:{toolCallId:'call',isError:true,content:[{type:'text',text:JSON.stringify(receipt)}]}}}}],1),[])
})
test('损坏、跨本人、无身份或未支持对象不产生卡片；同对象多个修改只留最新回执',()=>{
 assert.equal(conversationObjectReceipt({...receipt,role:{...role,id:'fake'}}),undefined)
 assert.equal(conversationObjectReceipt({...receipt,role:{...role,ownerId:'other'}}),undefined)
 assert.equal(conversationObjectReceipt({schema:'unknown',id:role.id}),undefined)
 const more=[...entries,{event:{type:'tool/call',seq:3,data:{turn:1,name:'teloa_employees_update',callId:'edit'}}},{event:{type:'tool/result',seq:4,data:{turn:1,message:{toolCallId:'edit',content:[{type:'text',text:JSON.stringify({...receipt,role:{...role,version:2,name:'小研更新'}})}]}}}}]
 assert.equal(conversationTurnObjectReceipts(more,1).length,1)
 assert.equal(conversationTurnObjectReceipts(more,1)[0]!.title,'小研更新')
})
test('知识与本人技能回执须绑定 canonical 本人身份、摘要版本和真实状态',()=>{
 const item={id:role.id,ownerId:role.ownerId,sourceId:'22222222-2222-4222-8222-222222222222',sourceType:'paste',workspaceId:'default',title:'核对流程',category:'sop',topics:[],scopeIds:['general'],currentVersion:1,status:'active',createdAt:role.createdAt,updatedAt:role.updatedAt}
 const version={knowledgeId:item.id,ownerId:item.ownerId,sourceId:item.sourceId,sourceType:'paste',version:1,contentHash:'a'.repeat(64),bytes:6,markdown:'流程',createdAt:item.createdAt}
 const library={schema:'teloa.library-result/v1',sessionId:'source',sourceSession:'source',ownerId:role.ownerId,operation:'teloa_library_save',kind:'knowledge',id:item.id,title:item.title,version:1,state:'saved',knowledge:{item,version}}
 assert.equal(conversationObjectReceipt(library,'source')?.kind,'knowledge')
 for(const changed of [{ownerId:'other'},{sourceSession:'other'},{id:version.sourceId},{version:2},{state:'active'}])assert.equal(conversationObjectReceipt({...library,...changed}),undefined)
 assert.equal(conversationObjectReceipt(library,'other'),undefined)
 const skill={schema:'teloa.skill-result/v1',sessionId:'source',operation:'edit',skill:{id:'source-review',nativeName:'source-review',ownerId:role.ownerId,installationId:role.id,contentId:version.sourceId,title:'资料核对',description:'检查来源',version:'1.2.0',state:'saved',availability:'enabled',selected:false,private:true},selection:{installationId:'33333333-3333-4333-8333-333333333333',version:1},expectedBundleHash:'a'.repeat(64),body:'# 核对'}
 assert.equal(conversationObjectReceipt(skill)?.id,role.id)
 for(const changed of [{ownerId:'other'},{installationId:'fake'},{private:false},{state:'applied'}])assert.equal(conversationObjectReceipt({...skill,skill:{...skill.skill,...changed}}),undefined)
 const pair=(name:string,value:unknown)=>[{event:{type:'tool/call',seq:1,data:{turn:1,name,callId:'new'}}},{event:{type:'tool/result',seq:2,data:{turn:1,message:{toolCallId:'new',content:[{type:'text',text:JSON.stringify(value)}]}}}}]
 assert.equal(conversationTurnObjectReceipts(pair('teloa_library_save',library),1,'source')[0]?.title,item.title)
 assert.deepEqual(conversationTurnObjectReceipts(pair('unknown',library),1),[])
})

test('配置回执严格绑定本人对象、实际版本和资源类型；目录结果不生成卡',()=>{
 const extension={schema:'teloa.capability-result/v1',sessionId:'source',operation:'teloa_extensions_set',value:{id:'local-embedding',version:'1.0.0',state:'active'},resource:{kind:'extension',id:'local-embedding',ownerId:role.ownerId,title:'本地检索',version:'1.0.0',state:'active'}}
 assert.equal(conversationObjectReceipt(extension,'source')?.kind,'extension')
 for(const changed of [{ownerId:'other'},{id:'arbitrary-extension'},{state:'healthy'},{version:'2.0.0'}])assert.equal(conversationObjectReceipt({...extension,resource:{...extension.resource,...changed}}),undefined)
 assert.equal(conversationObjectReceipt(extension,'other'),undefined)
 assert.equal(conversationObjectReceipt({...extension,resource:undefined}),undefined)
 assert.equal(conversationObjectReceipt({...extension,operation:'teloa_extensions_list'}),undefined)
 const connector={...extension,operation:'teloa_connector_instances_get',value:{id:role.id},resource:{kind:'connector',id:role.id,ownerId:role.ownerId,title:'业务数据',version:1,state:'needs_authorization',connectorKind:'data-source'}}
 assert.equal(conversationObjectReceipt(connector)?.connectorKind,'data-source')
 assert.equal(conversationObjectReceipt({...connector,resource:{...connector.resource,connectorKind:'shell'}}),undefined)
 const skill={...extension,operation:'teloa_skill_availability_change',value:{},resource:{kind:'skill',id:'source-review',ownerId:role.ownerId,title:'核对流程',version:'1.0.0',state:'saved',installationId:role.id,contentId:'22222222-2222-4222-8222-222222222222',nativeName:'source-review'}}
 assert.equal(conversationObjectReceipt(skill)?.id,role.id)
 assert.equal(conversationObjectReceipt({...skill,resource:{...skill.resource,installationId:'source-review'}}),undefined)
 const grant={...extension,operation:'teloa_group_agent_grant_change',resource:{kind:'group-agent-grant',id:role.id,groupId:role.id,roleId:'22222222-2222-4222-8222-222222222222',ownerId:role.ownerId,title:'协作群',version:2,state:'revoked'}}
 assert.equal(conversationObjectReceipt(grant)?.kind,'group')
 assert.equal(conversationObjectReceipt({...grant,resource:{...grant.resource,groupId:'other'}}),undefined)
})

test('industry-local/public 使用真实安装、方案、选择与启停 shape，只读核对身份范围版本',async()=>{
 const loadId='33333333-3333-4333-8333-333333333333',itemId='44444444-4444-4444-8444-444444444444',contentId='55555555-5555-4555-8555-555555555555'
 const load={id:loadId,ownerId:role.ownerId,contentId,contentHash:'a'.repeat(64),templateId:'review-plan',templateVersion:'1.0.0',templateTitle:'资料核对方案',domain:'general',scope:'general',description:'来源核对',targetVersion:1,space:{id:'66666666-6666-4666-8666-666666666666',name:'本人空间',version:1,scope:'general'},items:[{localId:'review-skill',instanceId:itemId,kind:'skill',title:'行业资料核对',version:'1.2.0',required:true,status:'pending-adapter'}],relations:[],entrypoints:[itemId],createdAt:role.createdAt,mappingHash:'b'.repeat(64),status:'active'}
 for(const kind of ['industry-local','industry-public']){
  const source={kind,loadId,itemInstanceId:itemId,contentId,contentHash:load.contentHash,resourceId:'review-skill',resourceVersion:'1.2.0',...(kind==='industry-public'?{sourceContentId:'77777777-7777-4777-8777-777777777777',sourceContentHash:'c'.repeat(64),sourceResourceId:'public-review',sourceResourceVersion:'3.0.0'}:{})}
  const installation={id:role.id,ownerId:role.ownerId,source,bundleHash:'d'.repeat(64),native:{name:'review-skill',description:'核对方案资料',modelInvocable:true,userInvocable:true,bodyHash:'e'.repeat(64)},state:'installed',version:1,createdAt:role.createdAt,updatedAt:role.updatedAt}
  const availability={ownerId:role.ownerId,installationId:role.id,availability:'disabled',version:1,updatedAt:role.updatedAt},selection={ownerId:role.ownerId,nativeName:'review-skill',installationId:role.id,version:1,updatedAt:role.updatedAt},value={kind:'industry',installation,load,availability,selection}
  const detail=await readConversationIndustrySkillDetail(value)
  assert.equal(detail.skill.title,'行业资料核对');assert.equal(detail.skill.state,'disabled');assert.equal(detail.installation.source.kind,kind);assert.equal(detail.load.scope,'general')
  assert.equal((await readConversationIndustrySkillDetail({...value,selection:{...selection,installationId:contentId}})).skill.state,'saved')
  for(const change of [
   {installation:{...installation,ownerId:'other'}},{load:{...load,ownerId:'other'}},{availability:{...availability,ownerId:'other'}},{selection:{...selection,ownerId:'other'}},
   {load:{...load,contentHash:'f'.repeat(64)}},{load:{...load,scope:'foreign'}},{load:{...load,items:[{...load.items[0],localId:'other'}]}},{load:{...load,items:[{...load.items[0],version:'2.0.0'}]}},
   {installation:{...installation,source:{...source,contentId:role.id}}},{installation:{...installation,source:{...source,itemInstanceId:role.id}}},{installation:{...installation,state:'preparing'}},
  ])await assert.rejects(readConversationIndustrySkillDetail({...value,...change}))
  if(kind==='industry-public')await assert.rejects(readConversationIndustrySkillDetail({...value,installation:{...installation,source:{...source,sourceContentHash:'not-a-hash'}}}))
 }
})


test('本人按名称查看原稿的成功正式预览在同轮直接复用原稿卡，失败与目录不生成猜测入口',()=>{
 const stamp='2026-10-12T00:00:00.000Z'
 const draft={id:'33333333-3333-4333-8333-333333333333',ownerId:'local:teloa-owner',requestId:'44444444-4444-4444-8444-444444444444',entity:'skill',title:'原稿',body:JSON.stringify({id:'source-review',title:'原稿',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64:Buffer.from('---\nname: source-review\ndescription: Review sources.\n---\nRead supplied sources.\n').toString('base64')}]}),bodyHash:'a'.repeat(64),status:'draft',createdAt:stamp,updatedAt:stamp}
 const preview={schema:'teloa.page-create-draft-preview/v1',draft,fields:[],fieldsTruncated:false,consequences:[],next:{endpoint:'page-create-drafts/preview',consentKeys:[]},computedAt:stamp}
 const pair=(value:unknown,isError=false)=>[{event:{type:'tool/call',seq:1,data:{turn:1,name:'teloa_create_drafts',callId:'lookup'}}},{event:{type:'tool/result',seq:2,data:{turn:1,message:{toolCallId:'lookup',isError,content:[{type:'text',text:JSON.stringify(value)}]}}}}] as never
 assert.deepEqual(conversationTurnObjectReceipts(pair(preview),1),[{kind:'draft',id:draft.id,title:'原稿',revision:stamp+':draft'}])
 assert.deepEqual(conversationTurnObjectReceipts(pair(preview,true),1),[])
 assert.deepEqual(conversationTurnObjectReceipts(pair({...preview,draft:{...draft,ownerId:'other'}}),1),[])
 assert.deepEqual(conversationTurnObjectReceipts(pair({schema:'teloa.page-create-draft-summaries/v1',drafts:[{id:draft.id,title:draft.title}]}),1),[])
 assert.deepEqual(conversationTurnObjectReceipts(pair(preview),2),[])
})


test('精确唯一名称的无正文原稿引用直接成为本会话入口，拒绝外人、跨会话及损坏引用',()=>{
 const stamp='2026-10-12T00:00:00.000Z',id='33333333-3333-4333-8333-333333333333'
 const draft={id,entity:'skill',title:'原稿',status:'draft',bodyHash:'a'.repeat(64),createdAt:stamp,updatedAt:stamp}
 const value={schema:'teloa.page-create-draft-reference/v1',ownerId:'local:teloa-owner',sessionId:'ordinary-read',draft}
 assert.deepEqual(conversationObjectReceipt(value,'ordinary-read'),{kind:'draft',id,title:'原稿',revision:stamp+':draft',draftReference:{entity:'skill',status:'draft'}})
 for(const bad of [{...value,ownerId:'other'},{...value,sessionId:'other'},{...value,draft:{...draft,id:'bad'}},{...value,draft:{...draft,entity:'unknown'}},{...value,draft:{...draft,scope:'foreign'}},{...value,draft:{...draft,body:'不得进入元数据入口'}},{...value,draft:{...draft,bodyHash:'bad'}},{...value,draft:{...draft,status:'running'}},{...value,draft:{...draft,status:'applied'}},{...value,draft:{...draft,updatedAt:'bad'}},{...value,draft:{...draft,ownerId:'other'}}])assert.equal(conversationObjectReceipt(bad,'ordinary-read'),undefined)
})


test('原稿引用沿公共业务范围契约接受下划线和连字符开头，仍拒绝 general 与非法范围',()=>{
 const stamp='2026-10-12T00:00:00.000Z'
 for(const entity of ['connector','business-definition','business-domain'])for(const scope of ['_sales','-ops','SOC']){
  const draft={id:'33333333-3333-4333-8333-333333333333',entity,title:'原稿',status:'draft',bodyHash:'a'.repeat(64),createdAt:stamp,updatedAt:stamp,scope}
  const reference={schema:'teloa.page-create-draft-reference/v1',ownerId:'local:teloa-owner',sessionId:'read',draft}
  assert.equal(conversationObjectReceipt(reference,'read')?.scope,scope)
  for(const invalid of ['general','','a b','a/b','a'.repeat(65)])assert.equal(conversationObjectReceipt({...reference,draft:{...draft,scope:invalid}},'read'),undefined)
 }
})


test('原稿只读结果生成同一原稿卡，但不接受安装动作、跨会话或跨本人回包',()=>{
 const stamp='2026-10-12T00:00:00.000Z',draft={id:'33333333-3333-4333-8333-333333333333',ownerId:role.ownerId,requestId:'44444444-4444-4444-8444-444444444444',entity:'role',title:'只读原稿',body:JSON.stringify({name:role.name,kind:'employee',scopes:['general'],duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:[],knowledge:[],responsibility:role.responsibility}),bodyHash:'a'.repeat(64),status:'draft',createdAt:stamp,updatedAt:stamp}
 const result={schema:'teloa.page-create-draft-read/v1',ownerId:role.ownerId,sessionId:'original-read',draft,readAt:stamp,next:{kind:'open-original',title:draft.title}}
 const receipt=conversationObjectReceipt(result,'original-read');assert.equal(receipt?.kind,'draft');assert.equal(receipt?.id,draft.id);assert.equal(receipt?.title,draft.title)
 for(const invalid of [{...result,ownerId:'other'},{...result,sessionId:'other'},{...result,draft:{...draft,ownerId:'other'}},{...result,readAt:'not-a-time'},{...result,next:{...result.next,endpoint:'skill-installations/install'}},{...result,next:{kind:'apply',title:draft.title}},{...result,next:{...result.next,title:'别的原稿'}},{...result,consequences:[]}])assert.equal(conversationObjectReceipt(invalid,'original-read'),undefined)
})


test('自然语言添加任务资料沿原任务卡片入口，只接受本会话成功工具调用',()=>{
 const task={id:role.id,ownerId:role.ownerId,title:'证据核对',goal:'核对证据',scope:'general',groupId:null,skills:[],version:2,state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:role.createdAt,updatedAt:role.updatedAt}
 const value={schema:'teloa.task-configuration-result/v1',operation:'saved',taskId:task.id,taskName:task.title,sessionId:'origin',executionStarted:false,task,materialOperation:'added',replayed:false}
 const entries=[{event:{type:'tool/call',data:{callId:'material-call',name:'teloa_task_materials_add',arguments:{}}}},{event:{type:'tool/result',data:{message:{toolCallId:'material-call',isError:false,content:[{type:'text',text:JSON.stringify(value)}]}}}}] as any
 assert.equal(conversationTurnObjectReceipts(entries,undefined,'origin')[0]?.id,task.id)
 assert.deepEqual(conversationTurnObjectReceipts(entries,undefined,'other'),[])
 entries[1].event.data.message.isError=true;assert.deepEqual(conversationTurnObjectReceipts(entries,undefined,'origin'),[])
})
