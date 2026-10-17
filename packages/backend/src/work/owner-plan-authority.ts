import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {PoolClient} from 'pg'
import {WorkError,readTaskRunModelPolicy,readTaskToolArgumentRules,workObject,type OwnerPlanFields,type PlanWorkConfiguration,type TaskRunModelPolicy,type TaskToolArgumentRule} from '@teloa/contract'
import type {WorkAccessLease} from './work-access.ts'
import type {AcceptedWorkSource} from './owner-work-authority.ts'
import type {PlanSource} from './plans.ts'
export type OwnerPlanSource=Extract<PlanSource,{kind:'method-reuse'}>
export type OwnerPlanPolicy={allowedTools:string[];modelPolicy:TaskRunModelPolicy;argumentRules?:TaskToolArgumentRule[];agentPresetId?:string}
export type OwnerPlanAuthority={
 verifySource:(db:PoolClient,owner:string,source:OwnerPlanSource)=>Promise<WorkAccessLease>
 capture:(owner:string,input:{requestId:string;fields:OwnerPlanFields;source:OwnerPlanSource;configuration:PlanWorkConfiguration;intent:'save-paused'|'create-and-enable'},db:PoolClient)=>Promise<{policy:OwnerPlanPolicy;admission:WorkAccessLease}>
 authorize:(owner:string,input:{requestId:string;planId:string;expectedVersion:number;expectedConfigVersion:number;operation:'enable'|'configure';source:OwnerPlanSource})=>Promise<WorkAccessLease>
}
export type OwnerPlanGrant={schema:'teloa.owner-plan-grant/v1';source?:AcceptedWorkSource;policy:OwnerPlanPolicy;sourceHash:string;policyHash:string}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value
export const ownerPlanHash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export function readOwnerPlanPolicy(value:unknown):OwnerPlanPolicy{
 const v=workObject(value,['allowedTools','modelPolicy',...(value&&typeof value==='object'&&Object.hasOwn(value,'argumentRules')?['argumentRules']:[]),...(value&&typeof value==='object'&&Object.hasOwn(value,'agentPresetId')?['agentPresetId']:[])])
 if(!Array.isArray(v.allowedTools)||v.allowedTools.length>256||v.allowedTools.some(name=>typeof name!=='string'||!/^[-a-zA-Z0-9_.]{1,128}$/.test(name))||new Set(v.allowedTools).size!==v.allowedTools.length||v.agentPresetId!==undefined&&(typeof v.agentPresetId!=='string'||!/^[-a-z0-9]{1,120}$/.test(v.agentPresetId)))throw new WorkError('teloa/invalid-input','本人计划的固定工具或模型范围不正确。')
 const allowedTools=v.allowedTools as string[],argumentRules=v.argumentRules===undefined?undefined:readTaskToolArgumentRules(v.argumentRules)
 if(argumentRules?.some(rule=>!allowedTools.includes(rule.name)))throw new WorkError('teloa/forbidden','本人计划工具规则超出原批准范围。')
 return {allowedTools:[...allowedTools],modelPolicy:readTaskRunModelPolicy(v.modelPolicy),...(argumentRules?{argumentRules}:{}),...(v.agentPresetId?{agentPresetId:v.agentPresetId as string}:{})}
}
export function makeOwnerPlanGrant(source:OwnerPlanSource,policy:OwnerPlanPolicy):OwnerPlanGrant{return {schema:'teloa.owner-plan-grant/v1',...(source.acceptedSource?{source:source.acceptedSource}:{}),policy:readOwnerPlanPolicy(policy),sourceHash:ownerPlanHash(source),policyHash:ownerPlanHash(readOwnerPlanPolicy(policy))}}
export function readOwnerPlanGrant(value:unknown,source:OwnerPlanSource):OwnerPlanGrant{
 const v=workObject(value,['schema',...(source.acceptedSource?['source']:[]),'policy','sourceHash','policyHash']),expected=makeOwnerPlanGrant(source,readOwnerPlanPolicy(v.policy))
 if(!isDeepStrictEqual(v,expected))throw new WorkError('teloa/storage-corrupt','本人计划授权与固定来源、工具或模型依据不一致。')
 return expected
}
