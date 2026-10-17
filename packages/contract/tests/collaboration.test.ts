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

test('宿主长回复允许完整传入；群流只收摘要与固定全文身份，本人发送仍保留原上限',()=>{
 const full='# 核对结果\n\n'+'业务结论🙂。'.repeat(2000)
 assert.equal(groupRunMessageInput({requestId,runId,text:full}).text,full)
 const formatted='    '+full+'\n  '
 assert.equal(groupRunMessageInput({requestId,runId,text:formatted}).text===formatted,true,'完整长正文保留原首尾格式')
 assert.throws(()=>groupSendInput({requestId,groupId,expectedVersion:1,text:full}),{code:'teloa/invalid-input'})
 const employee={id:messageId,groupId,rootId,authorId:roleId,taskId,runId,text:'# 核对结果\n\n…',references:[],createdAt:'2026-10-15T00:00:00.000Z',fullText:{chars:full.length,sha256:'a'.repeat(64)}}
 assert.equal(isGroupMessage(employee),true)
 for(const fullText of [{chars:8000,sha256:'a'.repeat(64)},{chars:full.length,sha256:'bad'},{chars:full.length,sha256:'a'.repeat(64),text:full}])assert.equal(isGroupMessage({...employee,fullText}),false)
 const {taskId:_task,runId:_run,...human}=employee
 assert.equal(isGroupMessage({...human,authorId:'self',mentions:[]}),false,'本人消息不能伪造宿主全文快照')
})

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

test('群成员预期版本可选且必须与完整成员名单一一对应，不能新增身份、重复或改授权字段',()=>{
 const expectedMembers=[{roleId,expectedVersion:3}]
 const create={requestId,expectedVersion:0,fields,expectedMembers}
 assert.deepEqual(groupCreateInput(create),create)
 const change={requestId,groupId,expectedVersion:2,fields:{name:fields.name,announcement:fields.announcement,rules:openRules,memberRoleIds:[roleId],pinned:false,archived:false},expectedMembers}
 assert.deepEqual(groupChangeInput(change),change)
 for(const bad of [[],[...expectedMembers,...expectedMembers],[{roleId:groupId,expectedVersion:3}],[{roleId,expectedVersion:0}],[{roleId,expectedVersion:3,canAutoRun:true}]]){
  assert.throws(()=>groupCreateInput({...create,expectedMembers:bad}),{code:'teloa/invalid-input'})
  assert.throws(()=>groupChangeInput({...change,expectedMembers:bad}),{code:'teloa/invalid-input'})
 }
 assert.deepEqual(groupCreateInput({requestId,expectedVersion:0,fields:{...fields,memberRoleIds:[]},expectedMembers:[]}).expectedMembers,[])
 assert.equal('expectedMembers' in groupCreateInput({requestId,expectedVersion:0,fields}),false)
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

test('群授权可选 CAS 接受零和安全整数，旧调用不添字段并拒绝非法或未知版本键',()=>{
 const base={requestId,groupId,roleId,expectedGroupVersion:1,expectedRoleVersion:1,action:'save' as const,resources:[],canPost:false,canAutoRun:true}
 assert.deepEqual(groupAgentGrantChangeInput({...base,expectedGrantVersion:0}),{...base,expectedGrantVersion:0})
 assert.deepEqual(groupAgentGrantChangeInput({...base,expectedGrantVersion:3}),{...base,expectedGrantVersion:3})
 assert.equal(Object.hasOwn(groupAgentGrantChangeInput(base),'expectedGrantVersion'),false)
 for(const expectedGrantVersion of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'1',null,NaN])assert.throws(()=>groupAgentGrantChangeInput({...base,expectedGrantVersion}),{code:'teloa/invalid-input'})
 assert.throws(()=>groupAgentGrantChangeInput({...base,expectedGrantVersion:1,grantVersion:1}),{code:'teloa/invalid-input'})
})

test('groupTaskCreateInput 接受可选 trigger，非法值抛出',()=>{
  assert.deepEqual(groupTaskCreateInput({requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'mention'}),{requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'mention'})
  assert.deepEqual(groupTaskCreateInput({requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'routed'}),{requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'routed'})
  const withoutTrigger=groupTaskCreateInput({requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。'})
  assert.equal('trigger' in withoutTrigger,false)
  assert.throws(()=>groupTaskCreateInput({requestId,groupId,messageId,expectedGroupVersion:1,goal:'跟进证据链。',trigger:'auto'}),/群/)
})

test('群明确工作固定目标业务与负责人，可选对象必须属于同一业务；旧请求不增加字段',()=>{
 const base={requestId,groupId,messageId,expectedGroupVersion:1,goal:'维护原业务记录。'},assignee={roleId,expectedVersion:1},businessTarget={scope:'SOC',object:{scope:'SOC',type:'alert',id:'original-alert',version:2,snapshotHash:'a'.repeat(64)}}
 assert.deepEqual(groupTaskCreateInput({...base,assignee,businessTarget}),{...base,assignee,businessTarget})
 assert.equal('businessTarget'in groupTaskCreateInput(base),false)
 for(const patch of [{assignee:undefined,businessTarget},{assignee,businessTarget:{scope:'general'}},{assignee,businessTarget:{...businessTarget,scope:'AppSec'}},{assignee,businessTarget:{scope:'SOC',extra:true}},{assignee,businessTarget,trigger:'routed',executionMode:'reply',routingAttemptVersion:1}])assert.throws(()=>groupTaskCreateInput({...base,...patch}),{code:'teloa/invalid-input'})
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


test('员工显示位置和作者仅为服务端可读投影，旧九键消息兼容，本人发送不能自报这些字段',()=>{
 const old={id:messageId,groupId,rootId,authorId:roleId,taskId,runId,text:'正式回复',references:[],createdAt:'2026-10-15T00:00:00Z'}
 const author={name:'核对员',kind:'employee',version:2}
 assert.equal(isGroupMessage(old),true)
 assert.equal(isGroupMessage({...old,contextMode:'main',replyToMessageId:rootId,author}),true)
 for(const patch of [{contextMode:'unknown'},{replyToMessageId:messageId},{author:{...author,kind:'self'}},{author:{...author,version:0}},{author:{...author,ownerId:'other'}},{ownerId:'other'}])assert.equal(isGroupMessage({...old,...patch}),false)
 for(const patch of [{contextMode:'main'},{author}])assert.throws(()=>groupSendInput({requestId,groupId,expectedVersion:1,text:'测试',...patch}))
})
