import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createObjectConversationApi} from '../src/client/object-conversation-api.ts'
const id='16057272-ed9d-44a3-abe4-2ab04e056105',request={kind:'task' as const,objectId:id,expectedObjectVersion:1,sessionId:id,expectedLinkVersion:0,action:'link' as const},row={kind:'task',objectId:id,objectVersion:1,conversationId:id,sessionId:id,version:1,active:true,updatedAt:'2026-09-11T00:00:00Z'}
test('关联丢回包刷新恢复原请求，旧关联回执保留当前解除状态',async()=>{
 let raw:string|null=null;const calls:unknown[]=[],journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 await assert.rejects(createObjectConversationApi(async(_m,p)=>{calls.push(p);throw Error('断线')},journal).change(request),/断线/)
 const api=createObjectConversationApi(async(_m,p)=>{calls.push(p);return {...row,version:2,active:false}},journal)
 await assert.rejects(api.change({...request,action:'unlink'}),/原请求/)
 assert.equal((await api.recover()).active,false);assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
})
test('关系目录不能混入其他对象，当前响应必须对应原动作',async()=>{
 await assert.rejects(createObjectConversationApi(async()=>[{...row,kind:'role'}]).list('task',id),/关联/)
 const api=createObjectConversationApi(async()=>({...row,active:false}));await assert.rejects(api.change(request),/关联/);assert.ok(api.pending())
})
test('多业务数字员工会话在刷新后按当前会话恢复岗位与所选业务范围',async()=>{
 const roleId='26057272-ed9d-44a3-abe4-2ab04e056105',sessionId='role-session-1'
 let saved:typeof row&{kind:'role';objectId:string;sessionId:string;conversationId:string;scopeId:string}|undefined
 const call=async(method:string,payload:unknown)=>{
  if(method==='object-conversations/change'){
   const command=payload as {scopeId?:string}
   saved={...row,kind:'role',objectId:roleId,sessionId,conversationId:'role-conversation-1',scopeId:command.scopeId!}
   return saved
  }
  if(method==='object-conversations/session')return saved?[saved]:[]
  if(method==='object-conversations/list')return saved?[saved]:[]
  throw Error('unexpected endpoint')
 }
 await createObjectConversationApi(call).change({kind:'role',objectId:roleId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link',scopeId:'AppSec'})
 const refreshed=createObjectConversationApi(call)
 const current=await refreshed.bySession(sessionId),directory=await refreshed.list('role',roleId)
 assert.equal(current[0]?.kind,'role');assert.equal(current[0]?.scopeId,'AppSec');assert.equal(directory[0]?.scopeId,'AppSec')
})
test('任务上下文核验并保留固定业务对象快照',async()=>{
 const task={id,ownerId:'local:owner',title:'调查：异常脚本',goal:'研判',scope:'SOC',version:1,state:'running',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:01:00.000Z'}
 const objectBase={scope:'SOC',type:'alert',id:'alert-1',version:1,title:'异常脚本',source:'EDR',observedAt:'2026-09-14T00:00:00.000Z',receivedAt:'2026-09-14T00:00:01.000Z',quality:'complete',summary:'编码命令并外联。',fields:[{label:'资产',value:'prod-03'}]}
 const object={...objectBase,snapshotHash:createHash('sha256').update(JSON.stringify(objectBase)).digest('hex')}
 const source={schema:'teloa.business-task-source/v1',taskId:id,ownerId:task.ownerId,sourceId:'security-alert-http',reference:{scope:'SOC',type:'alert',id:'alert-1',version:1,snapshotHash:object.snapshotHash},createdAssignee:null,createdAt:task.createdAt}
 const context=await createObjectConversationApi(async()=>({task,role:null,link:row,business:{source,object}})).taskContext(id,id,1)
 assert.deepEqual(context.business,{source,object})
})

test('任务上下文按来源回执读取 AppSec 固定对象，不回落 SOC 来源',async()=>{
 const task={id,ownerId:'local:owner',title:'审查：可疑调用',goal:'核对影响范围',scope:'AppSec',version:1,state:'running',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:01:00.000Z'}
 const objectBase={scope:'AppSec',type:'finding',id:'finding-1',version:1,title:'可疑调用',source:'Code scanner',observedAt:'2026-09-14T00:00:00.000Z',receivedAt:'2026-09-14T00:00:01.000Z',quality:'complete',summary:'外部输入进入敏感调用。',fields:[{label:'仓库',value:'service-api'}]}
 const object={...objectBase,snapshotHash:createHash('sha256').update(JSON.stringify(objectBase)).digest('hex')}
 const source={schema:'teloa.business-task-source/v1',taskId:id,ownerId:task.ownerId,sourceId:'appsec-finding-http',reference:{scope:'AppSec',type:'finding',id:'finding-1',version:1,snapshotHash:object.snapshotHash},createdAssignee:null,createdAt:task.createdAt}
 const context=await createObjectConversationApi(async()=>({task,role:null,link:row,business:{source,object}})).taskContext(id,id,1)
 assert.deepEqual(context.business,{source,object})
})
