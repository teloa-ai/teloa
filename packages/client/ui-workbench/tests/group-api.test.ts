import test from 'node:test'
import assert from 'node:assert/strict'
import type {MessageReference} from '@teloa/contract'
import {createGroupApi} from '../src/client/group-api.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

const groupA='11111111-1111-4111-8111-111111111111'
const groupB='22222222-2222-4222-8222-222222222222'
const roleId='33333333-3333-4333-8333-333333333333'
const requestId='44444444-4444-4444-8444-444444444444'
const messageId='55555555-5555-4555-8555-555555555555'
const resourceId='66666666-6666-4666-8666-666666666666'
const at='2026-09-12T00:00:00.000Z'
const later='2026-09-12T00:01:00.000Z'

function group(id:string,pinned:boolean,updatedAt=at){return {id,ownerId:'self',version:1,name:'调查协作 '+id.slice(0,4),scope:'SOC',announcement:'先核对证据。',rules:openGroupRules,pinned,archived:false,createdAt:at,updatedAt}}
function entry(id:string,pinned=false,updatedAt=at){return {group:group(id,pinned,updatedAt),members:[{groupId:id,roleId:null,createdAt:at},{groupId:id,roleId,createdAt:at}]}}
function message(groupId:string,rootId:string|null=null){return {id:messageId,groupId,rootId,authorId:'self' as const,text:'补充证据。',references:[{kind:'group-resource' as const,id:resourceId,version:1}],mentions:[],createdAt:at}}
function deferred<T>(){let resolve:(value:T)=>void=()=>{},reject:(reason:unknown)=>void=()=>{};const promise=new Promise<T>((ok,bad)=>{resolve=ok;reject=bad});return {promise,resolve,reject}}

test('群目录和话题消息读取，验证排序、成员、本人所有者与稳定身份',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='groups/list')return [group(groupA,true,later),group(groupB,false)]
  if(endpoint==='groups/get')return entry(groupA,true,later)
  if(endpoint==='groups/messages/list')return [message(groupA)]
  throw Error('unexpected endpoint')
 })
 const directory=await api.list()
 assert.deepEqual(directory.items.map(item=>item.id),[groupA,groupB])
 assert.equal(api.directorySnapshot()?.items[0]?.id,groupA)
 assert.equal((await api.get(groupA)).group.ownerId,'self')
 assert.equal((await api.messages(groupA)).items[0]?.authorId,'self')
 assert.deepEqual(calls,[
  {endpoint:'groups/list',payload:{}},
  {endpoint:'groups/get',payload:{groupId:groupA}},
  {endpoint:'groups/messages/list',payload:{groupId:groupA}},
 ])
})

test('目录、成员与消息回包的越权、重复身份、乱序和跨群话题全部拒绝',async()=>{
 const invalid=[
  [group(groupA,false),group(groupA,false)],
  [group(groupB,false),group(groupA,true,later)],
  [{...group(groupA,false),ownerId:'other'}],
 ]
 for(const value of invalid)await assert.rejects(createGroupApi(async()=>value).list(),/群目录/)
 const badMessages=createGroupApi(async(endpoint)=>endpoint==='groups/messages/list'?[{...message(groupA),groupId:groupB}]:[])
 await assert.rejects(badMessages.messages(groupA),/消息目录/)
})

test('群消息目录接受主目录里的话题回复，话题目录包含根消息与回复',async()=>{
 const replyId='77777777-7777-4777-8777-777777777777'
 const root=message(groupA),reply={...message(groupA,messageId),id:replyId,createdAt:later}
 const api=createGroupApi(async(_endpoint,payload)=>'rootId' in (payload as Record<string,unknown>)?[root,reply]:[root,reply])
 assert.deepEqual((await api.messages(groupA)).items.map(item=>item.id),[messageId,replyId])
 assert.deepEqual((await api.messages(groupA,messageId)).items.map(item=>item.id),[messageId,replyId])
 const otherRoot='88888888-8888-4888-8888-888888888888'
 const broken=createGroupApi(async()=>[root,{...reply,rootId:otherRoot}])
 await assert.rejects(broken.messages(groupA),/消息目录/)
})

test('全量与话题消息目录分别拒绝乱序、跨根、跨群和重复身份',async()=>{
 const replyId='77777777-7777-4777-8777-777777777777'
 const secondReplyId='88888888-8888-4888-8888-888888888888'
 const otherRootId='99999999-9999-4999-8999-999999999999'
 const latest='2026-09-12T00:02:00.000Z'
 const root=message(groupA)
 const reply={...message(groupA,messageId),id:replyId,createdAt:later}
 const secondReply={...message(groupA,messageId),id:secondReplyId,createdAt:latest}
 const rejects=async(items:unknown[],rootId?:string)=>assert.rejects(createGroupApi(async()=>items).messages(groupA,rootId),/消息目录/)

 // 无 rootId 是完整群消息流：回复的根必须同批存在，整批按 createdAt/id 排序。
 await rejects([reply,root])
 await rejects([root,{...reply,rootId:otherRootId}])
 await rejects([root,{...reply,groupId:groupB}])
 await rejects([root,{...root,createdAt:later}])

 // 带 rootId 是一个完整话题：根必须居首，之后只能有该根的有序回复。
 await rejects([reply],messageId)
 await rejects([root,secondReply,reply],messageId)
 await rejects([root,{...reply,rootId:otherRootId}],messageId)
 await rejects([root,{...reply,groupId:groupB}],messageId)
 await rejects([root,reply,{...reply,createdAt:latest}],messageId)
})

test('正式宿主身份由装配层固定，不能把 local:teloa-owner 误判为越权回包',async()=>{
 const ownerId='local:teloa-owner',fields={name:'验收协作群',scope:'SOC',announcement:'固定协作范围。',rules:openGroupRules,memberRoleIds:[roleId]}
 const localGroup={...group(groupA,false),ownerId,name:fields.name,announcement:fields.announcement}
 const api=createGroupApi(async endpoint=>endpoint==='groups/create'?localGroup:{group:localGroup,members:[{groupId:groupA,roleId:null,createdAt:at},{groupId:groupA,roleId,createdAt:at}]},undefined,()=>requestId,ownerId)
 const created=await api.create(fields)
 assert.equal(created.group.ownerId,ownerId)
 await assert.rejects(createGroupApi(async()=>[localGroup]).list(),/群目录/)
})

test('创建回包未知时恢复同一请求，不同命令不能覆盖待核对请求',async()=>{
 let raw:string|null=null,phase:'lost'|'ready'='lost';const sent:unknown[]=[]
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(endpoint:string,payload:unknown)=>{sent.push({endpoint,payload});if(phase==='lost')throw Error('lost');if(endpoint==='groups/create')return {...group(groupA,false),name:'调查协作'};if(endpoint==='groups/get')return {...entry(groupA),group:{...group(groupA,false),name:'调查协作'}};throw Error('unexpected endpoint')}
 const first=createGroupApi(call,journal,()=>requestId)
 const fields={name:'调查协作',scope:'SOC',announcement:'先核对证据。',rules:openGroupRules,memberRoleIds:[roleId]}
 await assert.rejects(first.create(fields),/lost/)
 assert.ok(raw)
 await assert.rejects(first.create({...fields,name:'另一个群'}),/先核对/)
 phase='ready'
 const second=createGroupApi(call,journal,()=>crypto.randomUUID())
 const result=await second.recover()
 if(!('group' in result))throw Error('创建不应返回消息。')
 assert.equal(result.group.id,groupA)
 assert.deepEqual(sent,[
  {endpoint:'groups/create',payload:{requestId,expectedVersion:0,fields}},
  {endpoint:'groups/create',payload:{requestId,expectedVersion:0,fields}},
  {endpoint:'groups/get',payload:{groupId:groupA}},
 ])
 assert.equal(raw,null)
})

test('创建与修改遵循服务端的群回包，并在成功后重读成员快照',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const fields={name:'调查协作',scope:'SOC',announcement:'先核对证据。',rules:openGroupRules,memberRoleIds:[roleId]}
 const api=createGroupApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='groups/create')return {...group(groupA,false),name:fields.name}
  if(endpoint==='groups/get')return {...entry(groupA),group:{...group(groupA,false),name:fields.name}}
  throw Error('unexpected endpoint')
 },undefined,()=>requestId)
 const created=await api.create(fields)
 if(!('group' in created))throw Error('创建必须返回读取后的群详情。')
 assert.deepEqual(created.members.map(member=>member.roleId),[null,roleId])
 assert.deepEqual(calls,[
  {endpoint:'groups/create',payload:{requestId,expectedVersion:0,fields}},
  {endpoint:'groups/get',payload:{groupId:groupA}},
 ])
})

test('服务明确声明无副作用拒绝才释放待写入请求，未知失败继续保留',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const fields={name:'调查协作',scope:'SOC',announcement:'先核对证据。',rules:openGroupRules,memberRoleIds:[roleId]}
 const denied=createGroupApi(async()=>{throw Object.assign(Error('拒绝'),{rejected:true,noSideEffect:true,code:'teloa/version-conflict'})},journal,()=>requestId)
 await assert.rejects(denied.create(fields),/拒绝/)
 assert.equal(denied.pending(),undefined)
 assert.equal(raw,null)
 const unknown=createGroupApi(async()=>{throw Error('网络中断')},journal,()=>requestId)
 await assert.rejects(unknown.create(fields),/网络中断/)
 assert.equal(unknown.pending()?.request.requestId,requestId)
 assert.ok(raw)
})

test('已加载目录确认群目标不存在或归档时，受控清除不可导航的恢复请求',()=>{
 let raw:string|null=JSON.stringify({schema:'teloa.groups/v1',command:{kind:'change',request:{requestId,groupId:groupA,expectedVersion:1,fields:{name:'调查协作',announcement:'更新',memberRoleIds:[],pinned:false,archived:false}}}})
 const api=createGroupApi(async()=>{throw Error('不应请求网络')},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
 assert.equal(api.discardInaccessibleRecovery(),false)
 const pending=api.pending()
 if(!pending||pending.kind==='create')throw Error('恢复请求应为群变更')
 assert.equal(pending.request.groupId,groupA)
 assert.equal(api.discardInaccessibleRecovery([ {...group(groupA,false),archived:true} ]),true)
 assert.equal(api.pending(),undefined)
 assert.equal(raw,null)
})

test('群变更与发送均固定版本和请求身份，回执必须逐字段对应原操作',async()=>{
 const secondRequestId='77777777-7777-4777-8777-777777777777',calls:{endpoint:string;payload:unknown}[]=[]
 const fields={name:'调查协作 v2',announcement:'保留原成员。',rules:openGroupRules,memberRoleIds:[],pinned:true,archived:false}
 const api=createGroupApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='groups/change')return {...group(groupA,true,later),version:3,name:fields.name,announcement:fields.announcement}
  if(endpoint==='groups/get')return {group:{...group(groupA,true,later),version:3,name:fields.name,announcement:fields.announcement},members:[{groupId:groupA,roleId:null,createdAt:at}]}
  if(endpoint==='groups/messages/send')return message(groupA)
  throw Error('unexpected endpoint')
 },undefined,(()=>{const ids=[requestId,secondRequestId];return ()=>ids.shift()!})())
 const changed=await api.change(groupA,2,fields)
 if(!('group' in changed))throw Error('群变更不应返回消息。')
 // 旧引用形状 {resourceId,resourceVersion} 仍按群资料归一化通过客户端解析器：钉住这一点，
 // 发送前经 groupSendInput() 归一化后，实际上网的 payload 必须是新判别联合形状。
 const references=[{resourceId,resourceVersion:1}] as unknown as MessageReference[]
 const normalizedReferences:MessageReference[]=[{kind:'group-resource',id:resourceId,version:1}]
 const sent=await api.send(groupA,3,'补充证据。',undefined,references)
 if('group' in sent)throw Error('消息发送不应返回群快照。')
 assert.equal(changed.group.version,3)
 assert.equal(sent.id,messageId)
 assert.deepEqual(calls,[
  {endpoint:'groups/change',payload:{requestId,groupId:groupA,expectedVersion:2,fields}},
  {endpoint:'groups/get',payload:{groupId:groupA}},
  {endpoint:'groups/messages/send',payload:{requestId:secondRequestId,groupId:groupA,expectedVersion:3,text:'补充证据。',references:normalizedReferences}},
 ])
})

test('同一目录的较早读取即使更晚返回，也不会覆盖更新世代的快照',async()=>{
 const first=deferred<unknown>(),second=deferred<unknown>();let calls=0
 const api=createGroupApi(async()=>++calls===1?first.promise:second.promise)
 const old=api.list(),fresh=api.list()
 second.resolve([group(groupB,false)])
 await fresh
 first.resolve([group(groupA,false)])
 await old
 assert.equal(api.directorySnapshot()?.items[0]?.id,groupB)
})

test('群资料目录、固定版本与保存撤回回执逐项核对',async()=>{
 const resource={id:resourceId,groupId:groupA,ownerId:'self',version:1,title:'prod-03 证据',withdrawnAt:null,createdAt:at,updatedAt:at}
 const version={resourceId,groupId:groupA,version:1,title:resource.title,markdown:'# prod-03\n\n固定线索。',createdAt:at}
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='groups/resources/list')return [resource]
  if(endpoint==='groups/resources/get')return version
  if(endpoint==='groups/resources/save')return resource
  if(endpoint==='groups/resources/withdraw')return {...resource,withdrawnAt:later,updatedAt:later}
  throw Error('unexpected endpoint')
 },undefined,()=>requestId)
 assert.equal((await api.resources(groupA)).items[0]?.title,resource.title)
 assert.equal((await api.resource(groupA,resourceId,1)).markdown,version.markdown)
 const saved=await api.saveResource(groupA,resourceId,0,resource.title,version.markdown)
 if(!('title' in saved)||saved.title!==resource.title)throw Error('资料保存回执不正确。')
 const withdrawn=await api.withdrawResource(groupA,resourceId,1)
 if(!('withdrawnAt' in withdrawn)||withdrawn.withdrawnAt===null)throw Error('资料撤回回执不正确。')
 assert.deepEqual(calls.map(call=>call.endpoint),['groups/resources/list','groups/resources/get','groups/resources/save','groups/resources/withdraw'])
})

test('群数字员工授权读取与保存固定版本，回包不匹配时保留恢复请求',async()=>{
 const normalizedResources:MessageReference[]=[{kind:'group-resource',id:resourceId,version:1}]
 const grant={groupId:groupA,roleId,groupVersion:1,roleVersion:1,grantVersion:1,state:'active' as const,resources:normalizedResources,canPost:true,canAutoRun:false,createdAt:at}
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='groups/agent-grants/get')return {groupVersion:1,roleVersion:1,grant,status:'active'}
  if(endpoint==='groups/agent-grants/change')return grant
  throw Error('unexpected endpoint')
 },undefined,()=>requestId)
 assert.equal((await api.agentGrant(groupA,roleId)).status,'active')
 // 旧引用形状仍按群资料归一化通过客户端解析器：钉住这一点，上网 payload 必须是新判别联合形状。
 const legacyResources=[{resourceId,resourceVersion:1}] as unknown as MessageReference[]
 const saved=await api.changeAgentGrant(groupA,roleId,1,1,'save',legacyResources,true,false)
 if(!('grantVersion' in saved))throw Error('授权保存回执不正确。')
 assert.equal(saved.grantVersion,1)
 assert.deepEqual(calls,[
  {endpoint:'groups/agent-grants/get',payload:{groupId:groupA,roleId}},
  {endpoint:'groups/agent-grants/change',payload:{requestId,groupId:groupA,roleId,expectedGroupVersion:1,expectedRoleVersion:1,action:'save',resources:normalizedResources,canPost:true,canAutoRun:false}},
 ])
})

test('群数字员工授权保存把 canAutoRun 逐字带进请求 payload',async()=>{
 const grant={groupId:groupA,roleId,groupVersion:1,roleVersion:1,grantVersion:1,state:'active' as const,resources:[],canPost:false,canAutoRun:true,createdAt:at}
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupApi(async(endpoint,payload)=>{calls.push({endpoint,payload});if(endpoint==='groups/agent-grants/change')return grant;throw Error('unexpected endpoint')},undefined,()=>requestId)
 await api.changeAgentGrant(groupA,roleId,1,1,'save',[],false,true)
 assert.equal((calls[0]!.payload as {canAutoRun:boolean}).canAutoRun,true)
})

test('群消息创建任务固定消息、群版本和负责人，网络中断时保留原请求',async()=>{
 const taskId='88888888-8888-4888-8888-888888888888',calls:{endpoint:string;payload:unknown}[]=[]
 const response={task:{id:taskId,ownerId:'self',title:'群任务：补充证据。',goal:'形成研判结论。',scope:'SOC',version:1,state:'ready',assigneeRoleId:roleId,assigneeRoleVersion:1,createdAt:at,updatedAt:at},source:{schema:'teloa.group-task-source/v1' as const,taskId,ownerId:'self',groupId:groupA,groupVersion:1,messageId,rootId:messageId,messageCreatedAt:at,messageText:'补充证据。',references:[{kind:'group-resource' as const,id:resourceId,version:1}],createdAssignee:{roleId,roleVersion:1},trigger:'manual' as const,createdAt:at}}
 const api=createGroupApi(async(endpoint,payload)=>{calls.push({endpoint,payload});if(endpoint==='groups/tasks/create')return response;throw Error('unexpected endpoint')},undefined,()=>requestId)
 const saved=await api.createTask(groupA,messageId,1,'形成研判结论。',{roleId,expectedVersion:1})
 assert.equal(saved.task.id,taskId)
 assert.equal(saved.source.messageId,messageId)
 assert.deepEqual(calls,[{endpoint:'groups/tasks/create',payload:{requestId,groupId:groupA,messageId,expectedGroupVersion:1,goal:'形成研判结论。',assignee:{roleId,expectedVersion:1}}}])
 const broken=createGroupApi(async()=>({task:response.task,source:{...response.source,taskId:groupB}}),undefined,()=>requestId)
 await assert.rejects(broken.createTask(groupA,messageId,1,'形成研判结论。',{roleId,expectedVersion:1}),/回执/)
})

test('群消息创建任务传入 trigger:mention 时逐字进入请求，回执 trigger 不符即拒绝',async()=>{
 const taskId='99999999-9999-4999-8999-999999999999',calls:{endpoint:string;payload:unknown}[]=[]
 const response={task:{id:taskId,ownerId:'self',title:'群任务：补充证据。',goal:'形成研判结论。',scope:'SOC',version:1,state:'ready',assigneeRoleId:roleId,assigneeRoleVersion:1,createdAt:at,updatedAt:at},source:{schema:'teloa.group-task-source/v1' as const,taskId,ownerId:'self',groupId:groupA,groupVersion:1,messageId,rootId:messageId,messageCreatedAt:at,messageText:'补充证据。',references:[],createdAssignee:{roleId,roleVersion:1},trigger:'mention' as const,createdAt:at}}
 const api=createGroupApi(async(endpoint,payload)=>{calls.push({endpoint,payload});if(endpoint==='groups/tasks/create')return response;throw Error('unexpected endpoint')},undefined,()=>requestId)
 const saved=await api.createTask(groupA,messageId,1,'形成研判结论。',{roleId,expectedVersion:1},'mention')
 assert.equal(saved.source.trigger,'mention')
 assert.equal((calls[0]!.payload as {trigger?:string}).trigger,'mention')
 const mismatched=createGroupApi(async()=>({task:response.task,source:{...response.source,trigger:'manual'}}),undefined,()=>requestId)
 await assert.rejects(mismatched.createTask(groupA,messageId,1,'形成研判结论。',{roleId,expectedVersion:1},'mention'),/回执/)
})

test('发送消息按 mentions 是否传入决定 payload 是否带该键，原样带上不改写',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const mention={roleId,expectedVersion:1}
 const bare={...message(groupA),references:[]}
 const api=createGroupApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  const withMentions=(payload as {mentions?:unknown[]}).mentions!==undefined
  return {...bare,mentions:withMentions?[mention]:[]}
 },undefined,()=>requestId)
 await api.send(groupA,1,'补充证据。')
 await api.send(groupA,1,'补充证据。',undefined,undefined,[mention])
 assert.ok(!('mentions' in (calls[0]!.payload as object)),'未传 mentions 时 payload 不应出现该键')
 assert.deepEqual((calls[1]!.payload as {mentions?:unknown[]}).mentions,[mention])
})

test('同一 requestId 重放但 mentions 不同时，服务端按 teloa/conflict 拒绝且不清空原恢复请求',async()=>{
 let storedSpec:string|undefined
 const bare={...message(groupA),references:[]}
 const call=async(endpoint:string,payload:unknown)=>{
  if(endpoint!=='groups/messages/send')throw Error('unexpected endpoint')
  const spec=JSON.stringify(payload)
  if(storedSpec===undefined){storedSpec=spec;return bare}
  if(spec!==storedSpec)throw Object.assign(Error('同一消息请求不能更换内容。'),{rejected:true,code:'teloa/conflict'})
  return bare
 }
 const first=createGroupApi(call,undefined,()=>requestId)
 await first.send(groupA,1,'补充证据。')
 const mention={roleId,expectedVersion:1}
 const second=createGroupApi(call,undefined,()=>requestId)
 await assert.rejects(second.send(groupA,1,'补充证据。',undefined,undefined,[mention]),{code:'teloa/conflict'})
 assert.ok(second.pending(),'未声明 noSideEffect 的拒绝必须保留恢复请求')
})

test('群消息被贴密钥闸拒收：清除恢复记录（不留原文），之后可以正常发送',async()=>{
 let raw:string|null=null,blocked=true
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const bare={...message(groupA),text:'补充证据。',references:[]}
 const api=createGroupApi(async()=>{
  if(blocked)throw Object.assign(Error('检测到疑似密钥（GitHub），本条消息未发送。'),{rejected:true,code:'teloa/invalid-input',details:{reason:'secret-in-message',kinds:['github']}})
  return bare
 },journal,()=>requestId)
 await assert.rejects(api.send(groupA,1,'看 '+'gh'+'p_'+'a'.repeat(36)),{code:'teloa/invalid-input'})
 assert.equal(api.pending(),undefined)
 assert.equal(raw,null)
 blocked=false
 assert.equal((await api.send(groupA,1,'补充证据。') as {text:string}).text,'补充证据。')
 const other=createGroupApi(async()=>{throw Object.assign(Error('拒绝'),{rejected:true,code:'teloa/invalid-input',details:{reason:'other'}})},journal,()=>requestId)
 await assert.rejects(other.send(groupA,1,'补充证据。'),/拒绝/)
 assert.ok(other.pending(),'其他原因的拒绝未声明无副作用，仍保留恢复请求')
})
