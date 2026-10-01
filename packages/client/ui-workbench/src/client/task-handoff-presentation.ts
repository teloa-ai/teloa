import type {PreviewRole} from './role-preview.js'
import type {PreviewTask} from './task-preview.js'
import {roleSupportsScope} from '@teloa/contract'

export type ActiveHandoffCandidate=
 | {kind:'self';id:'self';version:null}
 | {kind:'role';id:string;name:string;version:number}

export function activeHandoffCandidates(task:PreviewTask,roles:readonly PreviewRole[]):ActiveHandoffCandidate[]{
 const self:ActiveHandoffCandidate[]=task.assigneeId==='self'?[]:[{kind:'self',id:'self',version:null}]
 return [...self,...roles.filter(role=>role.storage==='persistent'&&role.id!==task.assigneeId&&role.kind==='employee'&&role.state==='active'&&roleSupportsScope(role.scopes,task.scope)).map(role=>({kind:'role' as const,id:role.id,name:role.name,version:role.version}))]
}

/**
 * 待处理交接单能不能当场落地，只看两件事：任务还停得住（没在跑、没结束、没取消），
 * 而且它此刻仍挂在发起交接的那个岗位名下。判据在详情页表单与需要你决策卡上都要用，
 * 各写一份迟早会漂移，所以放在这里共用。
 */
export function canResolveHandoff(task:Pick<PreviewTask,'state'|'assigneeId'>,fromRoleId:string):boolean{
 return !['running','completed','cancelled'].includes(task.state)&&task.assigneeId===fromRoleId
}

export type ActiveHandoffState={visible:boolean;disabled:boolean;reason:'passive'|'state'|'recovery'|null}
export function activeHandoffState(task:PreviewTask,input:{passivePending:boolean;recovering:boolean}):ActiveHandoffState{
 if(input.passivePending)return {visible:false,disabled:true,reason:'passive'}
 if(task.storage!=='persistent'||['running','completed','cancelled'].includes(task.state))return {visible:false,disabled:true,reason:'state'}
 if(input.recovering)return {visible:true,disabled:true,reason:'recovery'}
 return {visible:true,disabled:false,reason:null}
}
