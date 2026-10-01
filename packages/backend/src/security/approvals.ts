import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readSecurityApproval,securityApprovalDecisionInput,securityActionSubmitInput,securityApprovalTtlMinutes,type SecurityPrincipal,type SecurityApproval,type SecurityAction,type SecurityActionDefinitionCatalog} from '@teloa/contract'
import {securityParamFingerprint} from './action-authorization.ts'
import {SecurityRequestJournal,type SecurityIdentity} from './request-journal.ts'
import {securityPrincipal,securityRequestSpec,securityStorageError,lockSecurityAction,requireSecurityActionVersion,recomputeSecurityActionFrozen,requireSecurityFrozenBaseline,appendSecurityActionAudit} from './actions.ts'

export async function initializeSecurityApprovals(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_security_approvals(
  id uuid primary key,owner_id text not null,action_id uuid not null,action_version integer not null check(action_version>0),decision text not null check(decision in ('approved','rejected')),
  approver_id text not null,reason text not null check(length(trim(reason))>0),impact_confirmed boolean not null,
  frozen jsonb not null check(jsonb_typeof(frozen)='object'),created_at timestamptz not null,record_digest text not null check(record_digest~'^sha256:[a-f0-9]{64}$'),
  unique(id,owner_id),unique(action_id,action_version),foreign key(action_id,owner_id) references teloa_security_actions(id,owner_id),check(decision<>'approved' or impact_confirmed)
 );
 create table if not exists teloa_security_approval_requests(
  owner_id text not null,request_id uuid not null,result_approval_id uuid not null,result_action_id uuid not null,result_action_version integer not null check(result_action_version>0),result_snapshot jsonb not null check(jsonb_typeof(result_snapshot)='object'),
  primary key(owner_id,request_id),foreign key(owner_id,request_id) references teloa_security_requests(owner_id,request_id),foreign key(result_approval_id,owner_id) references teloa_security_approvals(id,owner_id),foreign key(result_action_id,owner_id) references teloa_security_actions(id,owner_id)
 );
 create table if not exists teloa_security_action_attention_acknowledgements(
  owner_id text not null,request_id uuid not null,action_id uuid not null,action_version integer not null check(action_version>0),approver_id text not null,result_snapshot jsonb not null check(jsonb_typeof(result_snapshot)='object'),created_at timestamptz not null,
  primary key(owner_id,request_id),unique(action_id,action_version),foreign key(owner_id,request_id) references teloa_security_requests(owner_id,request_id),foreign key(action_id,owner_id) references teloa_security_actions(id,owner_id)
 );
 create or replace function teloa_security_append_only() returns trigger language plpgsql as $$ begin raise exception '安全审批与确认记录不可修改或删除'; end $$;
 create or replace trigger teloa_security_approvals_immutable before update or delete on teloa_security_approvals for each row execute function teloa_security_append_only();
 create or replace trigger teloa_security_approval_requests_immutable before update or delete on teloa_security_approval_requests for each row execute function teloa_security_append_only();
 create or replace trigger teloa_security_acknowledgements_immutable before update or delete on teloa_security_action_attention_acknowledgements for each row execute function teloa_security_append_only()
 ;alter table teloa_security_approvals add column if not exists expires_at timestamptz;
 -- 回填必须先摘触发器：teloa_security_approvals_immutable 对 update 一律 raise，
 -- 它会把自己的迁移打掉。整条初始化是一次 simple query，隐式单事务，中途没有第二个会话能插进来写。
 -- 但这段初始化每次启动都跑，回填只需要跑一次，所以先探一行再决定摘不摘：
 -- 空跑的代价不是零——drop/create 触发器要拿表级 AccessExclusiveLock，加上那条 update 本身覆盖全表，
 -- 等于每次启动都把审批表锁住扫一遍。有空值行才值得付这笔钱。
 do $$ begin
  if exists(select 1 from teloa_security_approvals where expires_at is null limit 1) then
   drop trigger if exists teloa_security_approvals_immutable on teloa_security_approvals;
   update teloa_security_approvals a set expires_at=a.created_at+(
    case s.risk_tier when 'high' then interval '15 minutes' when 'med' then interval '60 minutes' else interval '24 hours' end)
    from teloa_security_actions s where s.id=a.action_id and a.expires_at is null;
   create or replace trigger teloa_security_approvals_immutable before update or delete on teloa_security_approvals for each row execute function teloa_security_append_only();
  end if;
 end $$;
 alter table teloa_security_approvals alter column expires_at set not null`)
}

export function readStoredSecurityApproval(row:Record<string,unknown>):SecurityApproval{
 try{
  const approval=readSecurityApproval({id:row.id,ownerId:row.owner_id,actionId:row.action_id,actionVersion:row.action_version,decision:row.decision,approverId:row.approver_id,reason:row.reason,impactConfirmed:row.impact_confirmed,frozen:row.frozen,createdAt:(row.created_at as Date).toISOString()})
  if(row.record_digest!==securityParamFingerprint(approval)||approval.decision==='approved'&&!approval.impactConfirmed)throw Error()
  return approval
 }catch{throw securityStorageError()}
}

export class SecurityApprovalService{
 private readonly identity:SecurityIdentity
 private readonly catalog:SecurityActionDefinitionCatalog
 private readonly journal:SecurityRequestJournal
 constructor(_pool:Pool,identity:SecurityIdentity,catalog:SecurityActionDefinitionCatalog,journal:SecurityRequestJournal){this.identity=identity;this.catalog=catalog;this.journal=journal}
 async decide(principal:SecurityPrincipal,input:unknown):Promise<SecurityApproval>{
  securityPrincipal(principal);const request=securityApprovalDecisionInput(input)
  return this.journal.transaction(async db=>{
   const now=this.identity.now()
   if(await this.journal.reserve(db,principal.ownerId,request.requestId,'decide',securityRequestSpec('decide',principal,request),now)){
    const row=(await db.query('select * from teloa_security_approval_requests where owner_id=$1 and request_id=$2',[principal.ownerId,request.requestId])).rows[0]
    try{
     if(!row)throw Error()
     const approval=readSecurityApproval(row.result_snapshot)
     if(approval.id!==row.result_approval_id||approval.ownerId!==principal.ownerId||approval.actionId!==row.result_action_id||approval.actionVersion!==row.result_action_version||approval.actionId!==request.actionId||approval.actionVersion!==request.expectedActionVersion||approval.approverId!==principal.approverId||approval.decision!==request.decision||approval.reason!==request.reason||approval.impactConfirmed!==request.impactConfirmed)throw Error()
     const stored=(await db.query('select * from teloa_security_approvals where owner_id=$1 and id=$2 for share',[principal.ownerId,approval.id])).rows[0]
     if(!stored)throw Error()
     const authoritative=readStoredSecurityApproval(stored)
     if(securityParamFingerprint(approval)!==securityParamFingerprint(authoritative))throw Error()
     return approval
    }catch{throw securityStorageError()}
   }
   const {action,row}=await lockSecurityAction(db,principal,request.actionId);requireSecurityActionVersion(action,request.expectedActionVersion)
   if(action.state!=='pending_approval')throw new WorkError('teloa/conflict','只能决定待审批的安全动作。')
   if(request.decision==='approved'&&!request.impactConfirmed)throw new WorkError('teloa/forbidden','批准安全动作前必须明确确认影响范围。')
   const current=await recomputeSecurityActionFrozen(db,principal,row,this.catalog);requireSecurityFrozenBaseline(current,action.frozen)
   const approval=readSecurityApproval({id:this.identity.id(),ownerId:principal.ownerId,actionId:action.id,actionVersion:action.version,decision:request.decision,approverId:principal.approverId,reason:request.reason,impactConfirmed:request.impactConfirmed,frozen:action.frozen,createdAt:now})
   const expiresAt=new Date(Date.parse(now)+securityApprovalTtlMinutes[action.riskTier]*60_000).toISOString()
   await db.query('insert into teloa_security_approvals(id,owner_id,action_id,action_version,decision,approver_id,reason,impact_confirmed,frozen,created_at,record_digest,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[approval.id,approval.ownerId,approval.actionId,approval.actionVersion,approval.decision,approval.approverId,approval.reason,approval.impactConfirmed,JSON.stringify(approval.frozen),approval.createdAt,securityParamFingerprint(approval),expiresAt])
   await db.query('update teloa_security_actions set state=$2,version=version+1,updated_at=$3 where id=$1',[action.id,approval.decision,now])
   await db.query('insert into teloa_security_approval_requests(owner_id,request_id,result_approval_id,result_action_id,result_action_version,result_snapshot) values($1,$2,$3,$4,$5,$6)',[principal.ownerId,request.requestId,approval.id,action.id,action.version,JSON.stringify(approval)])
   await appendSecurityActionAudit(db,principal.ownerId,request.requestId,action.id,'decide',now)
   return approval
  })
 }
 /** 调用方开启并结束事务；本方法不另开连接，锁持续到外层 claim 提交。 */
 async readForExecution(db:PoolClient,principal:SecurityPrincipal,input:unknown):Promise<{action:SecurityAction;approval:SecurityApproval}>{
  securityPrincipal(principal)
  const inputRow=taskInput(input,['actionId','expectedActionVersion'])
  const request=securityActionSubmitInput({...inputRow,requestId:inputRow.actionId})
  const {action,row}=await lockSecurityAction(db,principal,request.actionId);requireSecurityActionVersion(action,request.expectedActionVersion)
  if(action.state!=='approved')throw new WorkError('teloa/conflict','安全动作尚未批准或批准已不可派发。')
  const frozen=await recomputeSecurityActionFrozen(db,principal,row,this.catalog);requireSecurityFrozenBaseline(frozen,action.frozen)
  const records=await db.query('select * from teloa_security_approvals where action_id=$1 and owner_id=$2 for share',[action.id,principal.ownerId])
  if(records.rows.length!==1)throw securityStorageError()
  const approval=readStoredSecurityApproval(records.rows[0])
  if(approval.decision!=='approved'||!approval.impactConfirmed||approval.actionVersion!==action.version-1)throw securityStorageError()
  requireSecurityFrozenBaseline(frozen,approval.frozen)
  // 过期是纯读判定：动作在库里仍是 approved，转移表与触发器一行不改（规格 §3.2 f）。
  // 判在冻结基线之后，是因为"冻结值已变"比"过期"更根本，两者同时成立时应报前者。
  const expiresAt=records.rows[0].expires_at
  if(!(expiresAt instanceof Date))throw securityStorageError()
  if(expiresAt.toISOString()<=this.identity.now())throw new WorkError('teloa/conflict','安全审批已过期，请撤回批准后重新提议并重新审批。')
  return {action,approval}
 }
}
