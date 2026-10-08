import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import type {ScheduleTrigger,DigitalRole} from '@teloa/contract'
import {readStoredPlan,type PlanService,type PersistentPlan} from './plans.ts'
import {BusinessScopeService} from './business-scopes.ts'

/** 用户 2026-09-21 裁定：默认 23:30，时区 Asia/Singapore。cadence 为 daily 时 weekday 不参与判定，取 1 只为通过既有解析器。 */
export const AUTO_DREAM_DEFAULT_TRIGGER:ScheduleTrigger={kind:'schedule',cadence:'daily',weekday:1,time:'23:30',timezone:'Asia/Singapore'}
export const AUTO_DREAM_PLAN_TITLE='Auto Dream · 每日小结'
export const AUTO_DREAM_PLAN_GOAL='只读当天与你自己有关的五类证据（运行、成果、审批、本人修订、群回帖），写一份私有工作日志；至多提出 3 条记忆候选与 3 条建议撤回。不创建、不推进、不结项任何业务任务，仅由服务端在本轮证据核验后保存小结成果，不发起审批，不往群里发言。'
export const AUTO_DREAM_PLAN_DATA_SCOPE='当天、本岗位的运行、成果版本、审批结果、本人修订与群回帖。不读其它岗位、不读其它日期、不读原生会话日志。'
export const AUTO_DREAM_PLAN_DELIVERY='一份私有只读的工作日志，至多 3 条记忆候选与 3 条建议撤回。记忆经来源与范围校验后自动保存并生效，可由本人查看和撤回。'

const shape=(parts:readonly string[]):string=>{
 const value=createHash('sha256').update(parts.join('\0')).digest('hex')
 return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}
/**
 * 同一位员工的计划身份恒定：重放不会建出第二条。
 * `purpose` 只收 `create` 与 `enable` 两个一次性用途——反复发生的暂停与复岗走 `cycleRequestId`（见下），
 * 恒定身份用在那两条上会在第二轮自毁，所以这里不留那两个取值。
 */
export function autoDreamRequestId(ownerId:string,roleId:string,purpose:'create'|'enable'):string{
 return shape(['teloa-auto-dream-plan/v1',ownerId,roleId,purpose])
}
/**
 * 暂停与复岗会反复发生，而 `teloa_plan_changes` 按 `request_id` 固定住当次的 `expectedVersion`：
 * 用恒定身份重放第二轮会被判成「原请求已记录其他计划操作」并回滚整笔岗位操作。
 * 把当次基线版本并进身份，同一版本的重放仍然逐字幂等，跨版本各记各的回执。
 */
function cycleRequestId(ownerId:string,roleId:string,purpose:'pause'|'resume',expectedVersion:number):string{
 return shape(['teloa-auto-dream-plan/v1',ownerId,roleId,purpose,String(expectedVersion)])
}

export type AutoDreamPorts={plans:Pick<PlanService,'createInTransaction'|'changeInTransaction'>}

const systemPlanSql="select * from teloa_plans where owner_id=$1 and source->>'kind'='system-digest' and source->>'roleId'=$2 order by created_at,id for update"

/**
 * Auto Dream 的开关与时刻的唯一载体：全部 system-digest 计划。时刻取其中最早创建的一条。
 *
 * 「开」只看**负责岗位仍在岗**的那些计划：随岗位暂停/退役而 paused 的计划记的是岗位状态，不是本人的开关意图，
 * 把它们算进来会让「唯一的员工退役后再招新人」静默落成关闭。在岗员工一个都没有时视为开启（默认开）。
 *
 * 任一行损坏即抛 `teloa/storage-corrupt`（`readStoredPlan` 的既有判据）并回滚调用方整笔事务，
 * 这是有意的 fail-closed：读不准设置就不该继续替本人决定要不要写小结。
 */
export async function readAutoDreamSetting(db:Pick<PoolClient,'query'>,ownerId:string):Promise<{enabled:boolean;trigger:ScheduleTrigger}|undefined>{
 const rows=(await db.query(`select p.*,r.state role_state from teloa_plans p join teloa_roles r on r.id=p.role_id and r.owner_id=p.owner_id
  where p.owner_id=$1 and p.source->>'kind'='system-digest' order by p.created_at,p.id`,[ownerId])).rows
 if(!rows.length)return undefined
 const plans=rows.map(row=>({plan:readStoredPlan(row as Record<string,unknown>),roleState:(row as Record<string,unknown>).role_state}))
 const live=plans.filter(item=>item.roleState==='active')
 return {enabled:!live.length||live.some(item=>item.plan.state==='active'),trigger:plans[0]!.plan.trigger}
}

/** 员工转 active（新建或复岗）时确保有一条 active 的系统计划；已存在即按需 enable，不重复建。 */
export async function ensureAutoDreamPlan(db:PoolClient,ports:AutoDreamPorts,ownerId:string,role:DigitalRole):Promise<PersistentPlan|undefined>{
 if(role.kind!=='employee'||role.state!=='active')return undefined
 const found=(await db.query(systemPlanSql,[ownerId,role.id])).rows[0]
 if(found){
  const plan=readStoredPlan(found as Record<string,unknown>)
  if(plan.state==='active')return plan
  if(plan.state!=='paused')return undefined
  // 岗位暂停期间本人可以把计划所属业务从范围里删掉。那时 enable 会被 `validateRole` 判 `teloa/forbidden`，
  // 而系统计划又不能归档——硬启用等于让这位员工永远复不了岗。原样留在 paused：复岗照常成功，
  // 小结停着，由界面提示本人补回范围（T10 的面）。
  if(!role.scopes.includes(plan.scope))return plan
  return ports.plans.changeInTransaction(db,ownerId,{planId:plan.id,requestId:cycleRequestId(ownerId,role.id,'resume',plan.version),expectedVersion:plan.version,action:'enable'})
 }
 // 招聘本身不校验业务范围是否登记，而 `createInTransaction` 会对未登记的范围整笔拒绝。
 // 取升序中第一个**已登记**的范围（确定性，不猜）；一个都没有就不建计划，不能因为小结拖垮一次招聘。
 let scope:string|undefined
 for(const candidate of [...role.scopes].sort())if(await BusinessScopeService.registered(db,ownerId,candidate)){scope=candidate;break}
 if(!scope)return undefined
 // 新员工跟随本人当前的 Auto Dream 设置：时刻照抄，已关就只建不启用。
 const setting=await readAutoDreamSetting(db,ownerId)
 const created=await ports.plans.createInTransaction(db,ownerId,{
  requestId:autoDreamRequestId(ownerId,role.id,'create'),
  fields:{title:AUTO_DREAM_PLAN_TITLE,goal:AUTO_DREAM_PLAN_GOAL,scope,dataScope:AUTO_DREAM_PLAN_DATA_SCOPE,delivery:AUTO_DREAM_PLAN_DELIVERY,roleId:role.id,expectedRoleVersion:role.version,trigger:setting?.trigger??AUTO_DREAM_DEFAULT_TRIGGER,notificationPolicy:'silent',completionPolicy:{kind:'verified',verifier:'system-digest',verifierVersion:1,authorizationVersion:1}},
  source:{kind:'system-digest',roleId:role.id},
 })
 if(setting&&!setting.enabled)return created
 return ports.plans.changeInTransaction(db,ownerId,{planId:created.id,requestId:autoDreamRequestId(ownerId,role.id,'enable'),expectedVersion:created.version,action:'enable'})
}

/** 员工 paused / retired 时把它的系统计划置 paused；已 paused 或不存在即返回 undefined，不报错。 */
export async function pauseAutoDreamPlan(db:PoolClient,ports:AutoDreamPorts,ownerId:string,roleId:string):Promise<PersistentPlan|undefined>{
 const found=(await db.query(systemPlanSql,[ownerId,roleId])).rows[0]
 if(!found)return undefined
 const plan=readStoredPlan(found as Record<string,unknown>)
 if(plan.state!=='active')return undefined
 return ports.plans.changeInTransaction(db,ownerId,{planId:plan.id,requestId:cycleRequestId(ownerId,roleId,'pause',plan.version),expectedVersion:plan.version,action:'pause',note:'Auto Dream 随员工暂停'})
}
