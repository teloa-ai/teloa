/**
 * `im/*` 扩展端点（规格 §8 表）：经 teloaWork.attachExtension 挂接，浏览器写端点由宿主登记幂等表后分发到此。
 * 入参一律过契约白名单；回包只含摘要（不含凭据值、ownerId 与会话指向）；配对码只经 im/pairing/create 回包交给设置页。
 */
import {WorkError,imBindingChangeInput,imBindingRemoveInput,imChannelIdInput,imChannelKinds,imChannelSaveInput,imGroupBindInput,imGroupUnbindInput,imStubChannelKind,type ImBindingSummary,type ImGroupBindingSummary} from '@teloa/contract'
import type {createAudit,ImAuditRow} from './core/audit.ts'
import type {createBindingStore,ImBinding,ImGroupBinding} from './core/bindings.ts'
import type {createChannelManager} from './core/channel-manager.ts'
import type {createPairingService} from './core/pairing.ts'

export type TeloaExtensionHandler=(endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<unknown>

export type ImEndpointDeps={
 manager:ReturnType<typeof createChannelManager>
 bindings:ReturnType<typeof createBindingStore>
 pairing:ReturnType<typeof createPairingService>
 /** teloaWork.invoke('roles/list',{}) */
 roles:()=>Promise<{id:string;name:string;version:number}[]>
 /** teloaWork.invoke('groups/list',{}) */
 groups:()=>Promise<{id:string;name:string}[]>
 audit:ReturnType<typeof createAudit>
 lock:{held:boolean}
 /** 验收桩渠道可用（TELOA_BROWSER_ACCEPTANCE=1 且设 TELOA_IM_STUB_PORT）；否则任何指向 stub 的请求一律 invalid-input。 */
 stub?:boolean
 /** 解绑后通知审批模块把该用户的待决卡编辑为「已失效」（功能验证 接线）。 */
 onBindingRemoved?:(channelId:string,imUserId:string)=>void
 now?:()=>string
}

const readEndpoints=new Set(['im/channels/list','im/bindings/list','im/groups/list'])
const invalid=():never=>{throw new WorkError('teloa/invalid-input','IM 通道请求包含未知字段或格式不正确。')}
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)

/** 列表入参：{} 或 {channelId}。 */
function listInput(payload:unknown,stub:boolean):{channelId?:string}{
 if(!isRecord(payload)||Object.keys(payload).some(key=>key!=='channelId'))invalid()
 const row=payload as Record<string,unknown>
 if(row.channelId===undefined)return {}
 if(!(imChannelKinds as readonly unknown[]).includes(row.channelId)&&!(stub&&row.channelId===imStubChannelKind))invalid()
 return {channelId:row.channelId as string}
}
function emptyInput(payload:unknown):void{
 if(!isRecord(payload)||Object.keys(payload).length>0)invalid()
}
const bindingSummary=(row:ImBinding):ImBindingSummary=>({channelId:row.channelId,imUserId:row.imUserId,displayName:row.displayName,boundAt:row.boundAt,target:row.target})
const groupSummary=(row:ImGroupBinding):ImGroupBindingSummary=>({channelId:row.channelId,chatId:row.chatId,groupId:row.groupId,boundAt:row.boundAt})

export function createImEndpointHandler(deps:ImEndpointDeps):TeloaExtensionHandler{
 const now=deps.now??(()=>new Date().toISOString())
 // 设置页操作的审计：无 IM 会话，chatId／imUserId 按需留空；审计失败不回滚已完成的操作。
 const audit=(row:Omit<ImAuditRow,'at'|'chatId'|'imUserId'|'result'>&Partial<Pick<ImAuditRow,'chatId'|'imUserId'>>)=>
  deps.audit.record({at:now(),chatId:'',imUserId:'',result:'ok',...row}).catch(()=>{})

 return async(endpoint,payload)=>{
  if(!deps.stub&&isRecord(payload)&&(payload.channelId===imStubChannelKind||payload.kind===imStubChannelKind))invalid()
  if(!deps.lock.held&&!readEndpoints.has(endpoint))throw new WorkError('teloa/conflict','IM 通道已由另一宿主连接，当前不可修改。')
  switch(endpoint){
   case 'im/channels/list':
    emptyInput(payload)
    return deps.manager.list()
   case 'im/channels/save':{
    const input=imChannelSaveInput(payload)
    const result=await deps.manager.save(input)
    // 只记 action 与 channelId，不记凭据值（审查 L3）。
    await audit({channelId:input.channelId,action:'channel-save'})
    return result
   }
   case 'im/channels/enable':{
    const {channelId}=imChannelIdInput(payload)
    const result=await deps.manager.enable(channelId)
    await audit({channelId,action:'enable'})
    return result
   }
   case 'im/channels/disable':{
    const {channelId}=imChannelIdInput(payload)
    const result=await deps.manager.disable(channelId)
    await audit({channelId,action:'disable'})
    return result
   }
   case 'im/channels/remove':{
    const {channelId}=imChannelIdInput(payload)
    await deps.manager.remove(channelId)
    await audit({channelId,action:'remove'})
    return {removed:true}
   }
   case 'im/pairing/create':{
    const {channelId}=imChannelIdInput(payload)
    const channel=(await deps.manager.list()).find(row=>row.channelId===channelId)
    if(!channel)throw new WorkError('teloa/not-found','没有找到该 IM 渠道。')
    if(!channel.enabled)throw new WorkError('teloa/conflict','请先启用该渠道再生成配对码。')
    if((await deps.bindings.list(channelId)).length>=1)throw new WorkError('teloa/forbidden','该渠道绑定人数已达上限，请先解绑。')
    return deps.pairing.create(channelId)
   }
   case 'im/bindings/list':
    return (await deps.bindings.list(listInput(payload,deps.stub===true).channelId)).map(bindingSummary)
   case 'im/bindings/remove':{
    const input=imBindingRemoveInput(payload)
    await deps.bindings.remove(input.channelId,input.imUserId)
    await audit({channelId:input.channelId,imUserId:input.imUserId,action:'unbind'})
    deps.onBindingRemoved?.(input.channelId,input.imUserId)
    return {removed:true}
   }
   case 'im/bindings/change':{
    const input=imBindingChangeInput(payload)
    const target=input.target
    if(target.kind==='role'&&!(await deps.roles()).some(role=>role.id===target.roleId))invalid()
    const row=await deps.bindings.change(input.channelId,input.imUserId,{target})
    // 只记 action 与 channelId（审查 L3）。
    await audit({channelId:input.channelId,action:'binding-change'})
    return bindingSummary(row)
   }
   case 'im/groups/list':
    return (await deps.bindings.groups.list(listInput(payload,deps.stub===true).channelId)).map(groupSummary)
   case 'im/groups/bind':{
    const input=imGroupBindInput(payload)
    if(!(await deps.groups()).some(group=>group.id===input.groupId))invalid()
    const row=await deps.bindings.groups.bind({channelId:input.channelId,chatId:input.chatId,groupId:input.groupId})
    await audit({channelId:input.channelId,chatId:input.chatId,action:'group-bind',targetId:input.groupId})
    return groupSummary(row)
   }
   case 'im/groups/unbind':{
    const input=imGroupUnbindInput(payload)
    await deps.bindings.groups.unbind(input.channelId,input.chatId)
    await audit({channelId:input.channelId,chatId:input.chatId,action:'group-unbind'})
    return {removed:true}
   }
   default:
    throw new WorkError('teloa/not-found','未提供此工作接口。')
  }
 }
}
