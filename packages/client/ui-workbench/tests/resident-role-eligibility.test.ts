import test from 'node:test'
import assert from 'node:assert/strict'
import {canReceiveTask,canConfigureRoleExecution,rolePeople,type PreviewRole} from '../src/client/role-preview.ts'
import * as groupPresentation from '../src/client/saved-collaboration-state.ts'
const {groupTaskAssignees,groupMentionCandidates}=groupPresentation
const roleId='11111111-1111-4111-8111-111111111111',delegationId='22222222-2222-4222-8222-222222222222'
const delegation={id:delegationId,ownerId:'owner',roleId,roleVersion:2,version:1,state:'active',scope:'general',allowedTools:[],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false,createdAt:'2026-10-09T00:00:00.000Z',updatedAt:'2026-10-09T00:00:00.000Z'}
const consent={schema:'teloa.twin-execution-consent/v1',id:'33333333-3333-4333-8333-333333333333',ownerId:'owner',roleId,roleVersion:2,version:1,authorization:{kind:'delegation',delegationId,delegationVersion:1},state:'active',createdAt:'2026-10-09T00:00:00.000Z'}
const access={roleId,roleVersion:2,delegations:[delegation],consents:[consent],canEditExecution:false}
const twin=(workAccess:unknown=undefined)=>({id:roleId,name:'分身',kind:'twin',state:'active',version:2,scopes:['general'],duty:'整理资料',dataScope:'本人选择资料',executionScope:'已确认范围',skills:[],knowledge:[],memories:[],history:[],storage:'persistent',workAccess}) as PreviewRole

test('分身缺省保持代拟；只有当前委托及匹配的本人回执允许接任务，身份不变为 self',()=>{
 assert.equal(canReceiveTask(twin(),'general'),false)
 assert.equal(canReceiveTask(twin(access),'general'),true)
 assert.notEqual(rolePeople([twin(access)])[1]!.id,'self')
})
test('暂停中、停用、撤销、旧版本及非对应授权都不能让分身接新任务',()=>{
 for(const state of ['pausing','paused','ending','ended'])assert.equal(canReceiveTask(twin({...access,delegations:[{...delegation,state}]}),'general'),false)
 for(const patch of [{roleVersion:1},{state:'revoked'},{authorization:{kind:'task',taskId:delegationId,taskContentVersion:1}},{authorization:{kind:'delegation',delegationId,delegationVersion:2}}])assert.equal(canReceiveTask(twin({...access,consents:[{...consent,...patch}]}),'general'),false)
 assert.equal(canReceiveTask(twin({...access,roleVersion:1}),'general'),false)
 assert.equal(canReceiveTask(twin({...access,delegations:[{...delegation,roleVersion:1}]}),'general'),false)
 assert.equal(canReceiveTask({...twin(access),state:'paused'},'general'),false)
 assert.equal(canReceiveTask(twin({...access,delegations:[{...delegation,scope:'SOC'}]}),'general'),false)
})
test('分身仅在服务端确认全部委托停用且无在途工作后才能配置，不靠暂停身份推断',()=>{
 assert.equal(canConfigureRoleExecution(twin(),undefined),false)
 assert.equal(canConfigureRoleExecution(twin(access),access as never),false)
 assert.equal(canConfigureRoleExecution(twin(access),{...access,canEditExecution:true} as never),true)
 assert.equal(canConfigureRoleExecution(twin(access),{...access,roleVersion:1,canEditExecution:true} as never),false)
})
test('已确认分身可作为获准群的任务负责人；未确认或其他群不能借 canAutoRun 获权',()=>{
 const groupId='55555555-5555-4555-8555-555555555555',members=[{groupId,roleId,createdAt:delegation.createdAt}]
 const role=twin({...access,delegations:[{...delegation,groupIds:[groupId]}]})
 assert.deepEqual(groupTaskAssignees(members,[role],'general').map(item=>item.id),[roleId])
 assert.deepEqual(groupTaskAssignees(members,[twin(access)],'general'),[])
 assert.deepEqual(groupMentionCandidates(members,[role]).map(item=>item.id),[roleId])
 assert.deepEqual(groupMentionCandidates(members,[twin()]),[])
})
test('新群回传使用不可变的执行身份快照，分身改名后也不显示本人或员工',()=>{
 const identity=groupPresentation.groupMessageIdentity({authorId:roleId,runId:'run',source:{schema:'teloa.group-run-source/v2',roleId,roleVersion:2,roleKind:'twin',roleName:'当时的分身'}},{[roleId]:'新名字'},((key:string)=>key) as never)
 assert.deepEqual(identity,{name:'当时的分身',kind:'twin'})
})
