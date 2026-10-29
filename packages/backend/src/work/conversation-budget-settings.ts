import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,readWorkBudgetPolicy,taskInput,workUuid,type WorkBudgetPolicy} from '@teloa/contract'
import {defaultWorkBudgetPolicy} from './work-budget.ts'

export type ConversationBudgetSettings={sessionId:string;version:number;configured:boolean;policy:WorkBudgetPolicy}
type Eligible=(owner:string,sessionId:string)=>Promise<void>
const session=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','新任务额度设置格式不正确。')
export async function initializeConversationBudgetSettings(pool:Pool){await pool.query(`
 create table if not exists teloa_conversation_budget_settings(
  owner_id text not null,session_id text not null,version integer not null check(version>0),policy jsonb not null,
  updated_at timestamptz not null,primary key(owner_id,session_id)
 );
 create table if not exists teloa_conversation_budget_changes(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null,result jsonb not null,
  primary key(owner_id,request_id)
 );
`)}

/** 只保存本人页面为本会话新交办选择的策略；不建立账户、重置用量或启动执行。 */
export class ConversationBudgetSettingsService{
 private pool:Pool;private now:()=>string;private eligible:Eligible
 constructor(pool:Pool,now:()=>string,eligible:Eligible){this.pool=pool;this.now=now;this.eligible=eligible}
 private async authorize(owner:string,sessionId:unknown):Promise<string>{
  if(typeof owner!=='string'||!owner.trim()||!session(sessionId))throw invalid()
  await this.eligible(owner,sessionId)
  return sessionId
 }
 private async current(db:Pool|PoolClient,owner:string,sessionId:string):Promise<ConversationBudgetSettings>{
  const row=(await db.query('select version,policy from teloa_conversation_budget_settings where owner_id=$1 and session_id=$2',[owner,sessionId])).rows[0]
  if(!row)return {sessionId,version:0,configured:false,policy:structuredClone(defaultWorkBudgetPolicy)}
  if(!Number.isSafeInteger(row.version)||row.version<1)throw new WorkError('teloa/storage-corrupt','新任务额度设置版本损坏。')
  return {sessionId,version:row.version,configured:true,policy:readWorkBudgetPolicy(row.policy)}
 }
 async read(owner:string,input:unknown){
  const value=taskInput(input,['sessionId']),sessionId=await this.authorize(owner,value.sessionId)
  return this.current(this.pool,owner,sessionId)
 }
 async configure(owner:string,input:unknown):Promise<ConversationBudgetSettings>{
  const value=taskInput(input,['sessionId','requestId','expectedVersion','policy']),sessionId=await this.authorize(owner,value.sessionId)
  if(!workUuid(value.requestId)||!Number.isSafeInteger(value.expectedVersion)||Number(value.expectedVersion)<0)throw invalid()
  const policy=readWorkBudgetPolicy(value.policy)
  if(policy.money!==null)throw invalid()
  const request={sessionId,requestId:value.requestId,expectedVersion:Number(value.expectedVersion),policy},db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-budget',owner])])
   const prior=(await db.query('select request_spec,result from teloa_conversation_budget_changes where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0]
   if(prior){
    if(!isDeepStrictEqual(prior.request_spec,request))throw new WorkError('teloa/conflict','原新任务额度请求已有不同设置，请先核对。')
    await this.authorize(owner,sessionId);await db.query('commit');return prior.result as ConversationBudgetSettings
   }
   const current=await this.current(db,owner,sessionId)
   if(current.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','新任务额度已在其他页面修改，请读取最新版后重新确认。')
   await this.authorize(owner,sessionId)
   const result={sessionId,version:current.version+1,configured:true,policy}
   await db.query('insert into teloa_conversation_budget_settings(owner_id,session_id,version,policy,updated_at) values($1,$2,$3,$4,$5) on conflict(owner_id,session_id) do update set version=excluded.version,policy=excluded.policy,updated_at=excluded.updated_at',[owner,sessionId,result.version,JSON.stringify(policy),this.now()])
   await db.query('insert into teloa_conversation_budget_changes(owner_id,request_id,request_spec,result) values($1,$2,$3,$4)',[owner,request.requestId,JSON.stringify(request),JSON.stringify(result)])
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
