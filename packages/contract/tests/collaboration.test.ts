import test from 'node:test'
import assert from 'node:assert/strict'
import { groupAgentGrantChangeInput, groupChangeFields, groupChangeInput, groupCreateInput, groupDefinition, groupListInput, groupMessageListInput, groupResourceGetInput, groupResourceListInput, groupResourceSaveInput, groupResourceWithdrawInput, groupRunMessageInput, groupSendInput, groupTaskCreateInput, isGroup, isGroupAgentGrant, isGroupMember, isGroupMessage, isGroupResource, isGroupResourceVersion, isGroupRules, isGroupTaskSource, isMessageReference, normalizeReferences } from '../src/collaboration.ts'

const groupId='11111111-1111-4111-8111-111111111111'
const requestId='22222222-2222-4222-8222-222222222222'
const roleId='33333333-3333-4333-8333-333333333333'
const messageId='44444444-4444-4444-8444-444444444444'
const rootId='55555555-5555-4555-8555-555555555555'
const resourceId='66666666-6666-4666-8666-666666666666'
const taskId='88888888-8888-4888-8888-888888888888'
const runId='99999999-9999-4999-8999-999999999999'
const openRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
const fields={name:'调查协作',scope:'SOC',announcement:'先核对证据。',rules:openRules,memberRoleIds:[roleId]}

test('群创建只接受固定定义、请求身份和空版本基线，不接受 owner 或 author',()=>{
  assert.deepEqual(groupCreateInput({requestId,expectedVersion:0,fields}),{requestId,expectedVersion:0,fields})
  for(const value of [
    {requestId,fields},
    {requestId,expectedVersion:1,fields},
    {requestId,expectedVersion:0,fields,ownerId:'forged'},
    {requestId,expectedVersion:0,fields:{...fields,authorId:'forged'}},
    {requestId,expectedVersion:0,fields:{...fields,memberRoleIds:['self']}},
  ])assert.throws(()=>groupCreateInput(value),/群/)
})

test('群变更固定业务范围，发送只提交正文、根消息和固定资料版本',()=>{
  assert.deepEqual(groupChangeInput({requestId,groupId,expectedVersion:2,fields:{name:'调查协作 v2',announcement:'保留原成员。',rules:openRules,memberRoleIds:[roleId],pinned:true,archived:false}}),{requestId,groupId,expectedVersion:2,fields:{name:'调查协作 v2',announcement:'保留原成员。',rules:openRules,memberRoleIds:[roleId],pinned:true,archived:false}})
  // 旧形状输入（无 kind）经 references() 归一化为判别联合新形状回包。
  assert.deepEqual(groupSendInput({requestId,groupId,expectedVersion:2,rootId,text:'补充证据。',references:[{resourceId,resourceVersion:3}]}),{requestId,groupId,expectedVersion:2,rootId,text:'补充证据。',references:[{kind:'group-resource',id:resourceId,version:3}]})
  for(const value of [
    {requestId,groupId,expectedVersion:2,fields:{name:'x',scope:'SOC',announcement:'',memberRoleIds:[],pinned:false,archived:false}},
    {requestId,groupId,expectedVersion:2,rootId,text:'补充',authorId:'forged'},
    {requestId,groupId,expectedVersion:2,rootId,text:'补充',messageId},
    {requestId,groupId,expectedVersion:2,text:'补充',references:[{resourceId,resourceVersion:1},{resourceId,resourceVersion:2}]},
  ])assert.throws(()=>('fields' in value?groupChangeInput(value):groupSendInput(value)),/群/)
})

test('群与消息跨边界对象保留稳定身份，服务端作者只能是本人',()=>{
  const group={id:groupId,ownerId:'local:owner',version:1,name:'调查协作',scope:'SOC',announcement:'先核对证据。',rules:openRules,pinned:false,archived:false,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}
  const member={groupId,roleId,createdAt:group.createdAt}
  const message={id:messageId,groupId,rootId,authorId:'self' as const,text:'补充证据。',references:[{kind:'group-resource' as const,id:resourceId,version:1}],mentions:[],createdAt:group.createdAt}
  assert.equal(isGroup(group),true)
  assert.equal(isGroupMember(member),true)
  assert.equal(isMessageReference(message.references[0]),true)
  assert.equal(isGroupMessage(message),true)
  assert.equal(isGroupMessage({...message,authorId:'forged'}),false)
  assert.equal(isGroupMessage({...message,rootId:messageId}),false)
  assert.equal(isGroup({...group,ownerId:''}),false)
})

test('群提及最多 8 个、roleId 不重复、expectedVersion 为正整数、roleId 必须是 uuid',()=>{
  const tooMany=Array.from({length:9},(_,index)=>({roleId:`${index}1111111-1111-4111-8111-111111111111`,expectedVersion:1}))
  const duplicated=[{roleId,expectedVersion:1},{roleId,expectedVersion:2}]
  const zeroVersion=[{roleId,expectedVersion:0}]
  const fractionalVersion=[{roleId,expectedVersion:1.5}]
  const notUuid=[{roleId:'not-a-uuid',expectedVersion:1}]
  for(const mentions of [tooMany,duplicated,zeroVersion,fractionalVersion,notUuid])
    assert.throws(()=>groupSendInput({requestId,groupId,expectedVersion:2,text:'补充证据。',mentions}),/群/)
})

test('群发送不传 mentions 时回包不含 mentions 键，传入合法提及时原样返回',()=>{
  const sent=groupSendInput({requestId,groupId,expectedVersion:2,text:'补充证据。'})
  assert.equal('mentions' in sent,false)
  const withMentions=groupSendInput({requestId,groupId,expectedVersion:2,text:'补充证据。',mentions:[{roleId,expectedVersion:1}]})
  assert.deepEqual(withMentions.mentions,[{roleId,expectedVersion:1}])
})

test('isGroupMessage 本人分支 7 键为假、8 键含空 mentions 为真，同事分支 9 键为真、多出 mentions 键为假',()=>{
  const base={id:messageId,groupId,rootId,text:'补充证据。',references:[{kind:'group-resource' as const,id:resourceId,version:1}],createdAt:'2026-09-12T00:00:00.000Z'}
  assert.equal(isGroupMessage({...base,authorId:'self' as const}),false)
  assert.equal(isGroupMessage({...base,authorId:'self' as const,mentions:[]}),true)
  assert.equal(isGroupMessage({...base,authorId:'self' as const,mentions:[{roleId,expectedVersion:1}]}),true)
  assert.equal(isGroupMessage({...base,authorId:'self' as const,mentions:[],extra:'forged'}),false)
  const employee={...base,authorId:roleId,taskId,runId}
  assert.equal(isGroupMessage(employee),true)
  assert.equal(isGroupMessage({...employee,mentions:[]}),false)
})

test('isGroupTaskSource 12 键为假、13 键含 manual/mention/routed 三者之一为真、relayed 与其它非法 trigger 为假',()=>{
  const base={schema:'teloa.group-task-source/v1' as const,taskId,ownerId:'local:owner',groupId,groupVersion:1,messageId,rootId,messageCreatedAt:'2026-09-12T00:00:00.000Z',messageText:'补充证据。',references:[],createdAssignee:null,createdAt:'2026-09-12T00:00:00.000Z'}
  assert.equal(isGroupTaskSource(base),false)
  assert.equal(isGroupTaskSource({...base,trigger:'mention' as const}),true)
  assert.equal(isGroupTaskSource({...base,trigger:'manual' as const}),true)
  assert.equal(isGroupTaskSource({...base,trigger:'routed' as const}),true)
  assert.equal(isGroupTaskSource({...base,trigger:'relayed'}),false)
  assert.equal(isGroupTaskSource({...base,trigger:'auto'}),false)
  assert.equal(isGroupTaskSource({...base,trigger:'manual' as const,extra:'forged'}),false)
})

test('isGroupAgentGrant 9 键为假、10 键为真，revoked 且 canAutoRun 为真时为假',()=>{
  const base={groupId,roleId,groupVersion:1,roleVersion:1,grantVersion:1,state:'active' as const,resources:[],canPost:false,createdAt:'2026-09-12T00:00:00.000Z'}
  assert.equal(isGroupAgentGrant(base),false)
  assert.equal(isGroupAgentGrant({...base,canAutoRun:false}),true)
  assert.equal(isGroupAgentGrant({...base,state:'revoked' as const,canAutoRun:true}),false)
  assert.equal(isGroupAgentGrant({...base,state:'revoked' as const,canPost:false,canAutoRun:false}),true)
  assert.equal(isGroupAgentGrant({...base,canAutoRun:false,extra:'forged'}),false)
})

test('groupAgentGrantChangeInput 撤销时 canAutoRun 必须为假、save 时三项不可同时为空',()=>{
  assert.throws(()=>groupAgentGrantChangeInput({requestId,groupId,roleId,expectedGroupVersion:1,expectedRoleVersion:1,action:'revoke',resources:[],canPost:false,canAutoRun:true}),/群/)
  assert.throws(()=>groupAgentGrantChangeInput({requestId,groupId,roleId,expectedGroupVersion:1,expectedRoleVersion:1,action:'save',resources:[],canPost:false,canAutoRun:false}),/群/)
  assert.deepEqual(groupAgentGrantChangeInput({requestId,groupId,roleId,expectedGroupVersion:1,expectedRoleVersion:1,action:'save',resources:[],canPost:false,canAutoRun:true}),{requestId,groupId,roleId,expectedGroupVersion:1,expectedRoleVersion:1,action:'save',resources:[],canPost:false,canAutoRun:true})
})

test('groupTaskCreateInput 接受可选 trigger，非法值抛出',()=>{
  assert.deepEqual(groupTaskCreateInput({requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'mention'}),{requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'mention'})
  assert.deepEqual(groupTaskCreateInput({requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'routed'}),{requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'routed'})
  const withoutTrigger=groupTaskCreateInput({requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。'})
  assert.equal('trigger' in withoutTrigger,false)
  assert.throws(()=>groupTaskCreateInput({requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'auto'}),/群/)
})

test('isGroupRules 仍然只认 3 键',()=>{
  assert.equal(isGroupRules(openRules),true)
  assert.equal(isGroupRules({...openRules,autoRunOnMention:true}),false)
})

test('目录与消息读取输入拒绝伪造身份和未知字段',()=>{
  assert.deepEqual(groupListInput({}),{})
  assert.deepEqual(groupMessageListInput({groupId,rootId}),{groupId,rootId})
  for(const value of [{ownerId:'forged'},{groupId,ownerId:'forged'}])assert.throws(()=>groupListInput(value),/群/)
  for(const value of [{groupId,rootId,authorId:'forged'},{groupId,rootId:'not-an-id'}])assert.throws(()=>groupMessageListInput(value),/群/)
})

test('群资料只接受固定群、版本和 Markdown 正文，不接受伪造归属',()=>{
  assert.deepEqual(groupResourceListInput({groupId}),{groupId})
  assert.deepEqual(groupResourceGetInput({groupId,resourceId,resourceVersion:2}),{groupId,resourceId,resourceVersion:2})
  assert.deepEqual(groupResourceSaveInput({requestId,groupId,resourceId,expectedVersion:0,title:'研判依据',markdown:'# 证据\n\n固定版本。'}),{requestId,groupId,resourceId,expectedVersion:0,title:'研判依据',markdown:'# 证据\n\n固定版本。'})
  assert.deepEqual(groupResourceWithdrawInput({requestId,groupId,resourceId,expectedVersion:2}),{requestId,groupId,resourceId,expectedVersion:2})
  for(const value of [
    {requestId,groupId,resourceId,expectedVersion:0,title:'资料',markdown:'正文',ownerId:'forged'},
    {requestId,groupId,resourceId,expectedVersion:-1,title:'资料',markdown:'正文'},
    {requestId,groupId,resourceId,expectedVersion:0,title:'资料',markdown:' '},
    {groupId,resourceId,resourceVersion:1,ownerId:'forged'},
  ])assert.throws(()=>('markdown' in value?groupResourceSaveInput(value):groupResourceGetInput(value)),/群/)
})

test('群资料与版本跨边界对象保留群与本人身份',()=>{
  const resource={id:resourceId,groupId,ownerId:'local:owner',version:2,title:'研判依据',withdrawnAt:null,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T01:00:00.000Z'}
  const resourceVersion={resourceId,groupId,version:2,title:'研判依据',markdown:'# 固定证据',createdAt:resource.updatedAt}
  assert.equal(isGroupResource(resource),true)
  assert.equal(isGroupResourceVersion(resourceVersion),true)
  assert.equal(isGroupResource({...resource,withdrawnAt:'not-a-time'}),false)
  assert.equal(isGroupResourceVersion({...resourceVersion,markdown:''}),false)
})

test('群规则缺省回落为全部允许，提交时三键必须都是布尔且不接受多余键',()=>{
  const {rules:_omitted,...withoutRules}=fields
  assert.deepEqual(groupDefinition(withoutRules).rules,openRules)
  assert.deepEqual(groupChangeFields({name:'调查协作',announcement:'',memberRoleIds:[],pinned:false,archived:false}).rules,openRules)
  const closed={historyVisibleToNewMembers:false,draftsVisibleInGroup:false,mentionAllAllowed:false}
  assert.deepEqual(groupDefinition({...fields,rules:closed}).rules,closed)
  for(const rules of [
    {historyVisibleToNewMembers:true,draftsVisibleInGroup:true},
    {historyVisibleToNewMembers:'true',draftsVisibleInGroup:true,mentionAllAllowed:true},
    {historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true,everyone:true},
    null,
  ])assert.throws(()=>groupDefinition({...fields,rules}),/群/)
  assert.equal(isGroup({id:groupId,ownerId:'local:owner',version:1,name:'调查协作',scope:'SOC',announcement:'',rules:{...openRules,everyone:true},pinned:false,archived:false,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}),false)
})

const uid=(n:number)=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`

test('isMessageReference 按 kind 三分支判据，键数必须严格等于 3',()=>{
  assert.equal(isMessageReference({kind:'group-resource',id:resourceId,version:1}),true)
  assert.equal(isMessageReference({kind:'group-resource',id:'not-a-uuid',version:1}),false)
  const artifactUuid=requestId
  const artifactNonUuidHex='ffffffff-ffff-ffff-ffff-ffffffffffff'
  assert.equal(isMessageReference({kind:'artifact',id:artifactUuid,version:1}),true)
  assert.equal(isMessageReference({kind:'artifact',id:artifactNonUuidHex,version:1}),true)
  assert.equal(isMessageReference({kind:'artifact',id:artifactNonUuidHex+'f',version:1}),false)
  assert.equal(isMessageReference({kind:'attachment',id:'my-file.png',version:1}),true)
  assert.equal(isMessageReference({kind:'attachment',id:'my-file.png',version:2}),false)
  for(const bad of ['blob:abc','data:abc','http://x','https://x','HTTP://X','HTTPS://X','file:abc','FILE:ABC'])
    assert.equal(isMessageReference({kind:'attachment',id:bad,version:1}),false)
  assert.equal(isMessageReference({kind:'attachment',id:'a'.repeat(513),version:1}),false)
  assert.equal(isMessageReference({kind:'group-resource',id:resourceId}),false)
  assert.equal(isMessageReference({kind:'group-resource',id:resourceId,version:1,extra:'forged'}),false)
})

test('references()／agentGrantResources() 归一化旧形状、按 kind:id 去重、维持上限',()=>{
  // 旧形状归一化：混合数组（一条旧一条新）都过，去重键改成 `${kind}:${id}`。
  const withMixed=groupSendInput({requestId,groupId,expectedVersion:2,text:'补充证据。',references:[{resourceId,resourceVersion:1},{kind:'artifact',id:requestId,version:1}]})
  assert.deepEqual(withMixed.references,[{kind:'group-resource',id:resourceId,version:1},{kind:'artifact',id:requestId,version:1}])
  // jsonb 回读的键序（id,kind,version）重建为固定键序 kind,id,version；客户端回执核对按 JSON 字面比对。
  const reordered=normalizeReferences([{id:requestId,kind:'artifact',version:1},{version:1,id:resourceId,kind:'attachment'}]) as Record<string,unknown>[]
  assert.deepEqual(reordered.map(r=>Object.keys(r)),[['kind','id','version'],['kind','id','version']])
  assert.equal(JSON.stringify(reordered[0]),JSON.stringify({kind:'artifact',id:requestId,version:1}))
  // `{resourceId}` 只有一个键——不是旧形状，交给 isMessageReference 判定，必然失败。
  assert.throws(()=>groupSendInput({requestId,groupId,expectedVersion:2,text:'补充证据。',references:[{resourceId}]}),/群/)
  // 同 id 不同 kind 不算重复。
  const sameId=groupSendInput({requestId,groupId,expectedVersion:2,text:'补充证据。',references:[{kind:'group-resource',id:resourceId,version:1},{kind:'attachment',id:resourceId,version:1}]})
  assert.equal(sameId.references?.length,2)
  // 同 kind 同 id 不同 version 算重复。
  assert.throws(()=>groupSendInput({requestId,groupId,expectedVersion:2,text:'补充证据。',references:[{kind:'group-resource',id:resourceId,version:1},{kind:'group-resource',id:resourceId,version:2}]}),/群/)
  // 9 条引用拒。
  const nineRefs=Array.from({length:9},(_,i)=>({kind:'group-resource' as const,id:uid(i),version:1}))
  assert.throws(()=>groupSendInput({requestId,groupId,expectedVersion:2,text:'补充证据。',references:nineRefs}),/群/)
  // agentGrantResources 33 条拒。
  const thirtyThree=Array.from({length:33},(_,i)=>({kind:'group-resource' as const,id:uid(i),version:1}))
  assert.throws(()=>groupAgentGrantChangeInput({requestId,groupId,roleId,expectedGroupVersion:1,expectedRoleVersion:1,action:'save',resources:thirtyThree,canPost:false,canAutoRun:false}),/群/)
})

test('groupRunMessageInput 只收路径声明的 files，不传过、超限重复越界都拒，不接受 references／attachments 键',()=>{
  const hex=(ch:string)=>ch.repeat(64)
  const claim=(path:string,sha:string)=>({path,sha256:sha})
  const withoutFiles=groupRunMessageInput({requestId,runId,text:'已定版'})
  assert.equal('files' in withoutFiles,false)
  const oneFile=[claim('a.txt',hex('a'))]
  assert.deepEqual(groupRunMessageInput({requestId,runId,text:'已定版',files:oneFile}).files,oneFile)
  const nineFiles=Array.from({length:9},(_,i)=>claim(`f${i}.txt`,hex(String(i))))
  assert.throws(()=>groupRunMessageInput({requestId,runId,text:'已定版',files:nineFiles}),/群/)
  const duplicated=[claim('a.txt',hex('a')),claim('a.txt',hex('a'))]
  assert.throws(()=>groupRunMessageInput({requestId,runId,text:'已定版',files:duplicated}),/群/)
  assert.throws(()=>groupRunMessageInput({requestId,runId,text:'已定版',files:[claim('/a.txt',hex('a'))]}),/群/)
  assert.throws(()=>groupRunMessageInput({requestId,runId,text:'已定版',files:[claim('../a.txt',hex('a'))]}),/群/)
  assert.throws(()=>groupRunMessageInput({requestId,runId,text:'已定版',files:[claim('a.txt','not-a-hash')]}),/群/)
  assert.throws(()=>groupRunMessageInput({requestId,runId,text:'已定版',references:[]}),/群/)
  assert.throws(()=>groupRunMessageInput({requestId,runId,text:'已定版',attachments:[]}),/群/)
})
