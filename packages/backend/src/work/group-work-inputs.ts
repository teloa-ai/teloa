import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,groupWorkInput,groupWorkInputTransitions,isGroupWorkInputReceipt,isMessageReference,normalizeReferences,type MessageReference,type GroupWorkInputReceipt,type GroupWorkInputState} from '@teloa/contract'

type Database=Pick<PoolClient,'query'>
const ownerId=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','群工作追加回执损坏，已停止读取。')
const settledRun=['ended','withdrawn','configuration_failed']

/**
 * 群对原工作的追加与停止回执（规格 §4.4、§6.7）。每条本人消息对同一任务至多一条回执；
 * 原群任务来源快照不回写，追加来源独立保存并按续办后的任务版本供新 Run 读取，旧 Run 不读取后来的追加。
 * 行不可删除、身份列不可改、终态不可改，由触发器兜底。
 */
export async function initializeGroupWorkInputs(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_group_work_inputs(
  owner_id text not null,request_id uuid not null,group_id uuid not null,message_id uuid not null,task_id uuid not null,
  operation text not null check(operation in ('continue','stop')),expected_task_version integer not null check(expected_task_version>0),
  payload_sha256 text not null check(payload_sha256~'^[a-f0-9]{64}$'),observed_run_id uuid,
  state text not null check(state in ('reserved','continued','accepted','unknown','rejected')),expected_content_version integer check(expected_content_version>0),
  task_version integer check(task_version>0),run_id uuid,native_request_id text,accepted_seq integer check(accepted_seq>=0),reason text,
  created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,request_id),unique(owner_id,message_id,task_id),
  foreign key(message_id,group_id) references teloa_group_messages(id,group_id),
  foreign key(task_id,owner_id) references teloa_tasks(id,owner_id)
 );
 alter table teloa_group_work_inputs add column if not exists expected_content_version integer check(expected_content_version>0);
 do $$ declare item record; begin
  for item in select conname from pg_constraint where conrelid='teloa_group_work_inputs'::regclass and contype='c' and pg_get_constraintdef(oid) like '%state%reserved%' and pg_get_constraintdef(oid) not like '%continued%' loop
   execute format('alter table teloa_group_work_inputs drop constraint %I',item.conname);
  end loop;
  if not exists(select 1 from pg_constraint where conrelid='teloa_group_work_inputs'::regclass and conname='teloa_group_work_inputs_state_v2') then
   alter table teloa_group_work_inputs add constraint teloa_group_work_inputs_state_v2 check(state in ('reserved','continued','accepted','unknown','rejected'));
  end if;
 end $$;
 drop index if exists teloa_group_work_inputs_open;
 create index if not exists teloa_group_work_inputs_open_v2 on teloa_group_work_inputs(owner_id,created_at) where state in ('reserved','continued','unknown');
 create or replace function teloa_group_work_inputs_guard() returns trigger language plpgsql as $$ begin
  if tg_op='DELETE' or (new.owner_id,new.request_id,new.group_id,new.message_id,new.task_id,new.operation,new.expected_task_version,new.payload_sha256,new.observed_run_id,new.created_at)
   is distinct from (old.owner_id,old.request_id,old.group_id,old.message_id,old.task_id,old.operation,old.expected_task_version,old.payload_sha256,old.observed_run_id,old.created_at)
   or old.state in ('accepted','rejected') and new.state<>old.state
  then raise exception 'teloa_group_work_inputs identity is immutable'; end if;
  return new;
 end $$;
 drop trigger if exists teloa_group_work_inputs_guard on teloa_group_work_inputs;
 create trigger teloa_group_work_inputs_guard before update or delete on teloa_group_work_inputs for each row execute function teloa_group_work_inputs_guard();
`)}

function receipt(row:Record<string,unknown>):GroupWorkInputReceipt{
 const value={requestId:row.request_id,taskId:row.task_id,taskVersion:row.task_version??row.expected_task_version,runId:row.run_id??null,state:row.state,nativeRequestId:row.native_request_id??null,acceptedSeq:row.accepted_seq??null,operation:row.operation}
 if(!isGroupWorkInputReceipt(value))throw corrupt()
 return value
}

export type GroupWorkContinuation={messageId:string;text:string;createdAt:string;references:MessageReference[]}
/** versioned：已为续办升过任务版本；未升版本但带原生身份的回执是向活动 Run 的即时追加。 */
export type GroupWorkInputRecord=GroupWorkInputReceipt&{groupId:string;messageId:string;observedRunId:string|null;versioned:boolean}

export class GroupWorkInputService{
 readonly pool:Pool
 readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}
 private async transaction<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}}

 /**
  * 登记追加或停止（与路由终态同事务调用）。同一 requestId 重放回同一回执；同一消息对同一任务只登记一次。
  * 原消息必须是本人在本群发出的；任务必须来自本群，且当前版本与期望一致——模型不能指向别的群或别人的对象。
  */
 async reserveInTransaction(db:Database,owner:string,input:unknown):Promise<GroupWorkInputReceipt>{
  ownerId(owner)
  const request=groupWorkInput(input),{requestId:_requestId,...payload}=request,sha=createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const prior=(await db.query('select * from teloa_group_work_inputs where owner_id=$1 and (request_id=$2 or (message_id=$3 and task_id=$4)) order by (request_id=$2) desc limit 1',[owner,request.requestId,request.messageId,request.taskId])).rows[0]
  if(prior){if(prior.payload_sha256!==sha)throw new WorkError('teloa/conflict','同一追加请求不能更换内容。');return receipt(prior)}
  const message=(await db.query('select author_id from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,request.groupId,request.messageId])).rows[0]
  if(!message||message.author_id!=='self')throw new WorkError('teloa/forbidden','只能由本人在本群的消息追加或停止原工作。')
  const task=(await db.query(`select t.version,t.state,t.content_version from teloa_tasks t join teloa_group_task_sources s on s.owner_id=t.owner_id and s.task_id=t.id
   where t.owner_id=$1 and t.id=$2 and s.group_id=$3 for share of t`,[owner,request.taskId,request.groupId])).rows[0]
  if(!task)throw new WorkError('teloa/forbidden','原工作不属于本群。')
  // 登记本身总是持久化：原工作已取消，或追加时原工作已被改过（停止不受版本推进影响），记为拒绝并给出原因，
  // 不能让路由定案成「无需处理」而本人的追加或停止无声丢失（规格 §5）。
  const reason=task.state==='cancelled'?'teloa/conflict':request.operation==='continue'&&task.version!==request.expectedTaskVersion?'teloa/version-conflict':null
  const observed=(await db.query('select id from teloa_task_runs where owner_id=$1 and task_id=$2 order by created_at desc,id desc limit 1',[owner,request.taskId])).rows[0]?.id??null
  const now=this.identity.now()
  const saved=(await db.query(`insert into teloa_group_work_inputs(owner_id,request_id,group_id,message_id,task_id,operation,expected_task_version,payload_sha256,observed_run_id,state,reason,expected_content_version,created_at,updated_at)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) returning *`,[owner,request.requestId,request.groupId,request.messageId,request.taskId,request.operation,request.expectedTaskVersion,sha,observed,reason?'rejected':'reserved',reason,task.content_version??1,now])).rows[0]
  return receipt(saved!)
 }

 async get(owner:string,requestId:string):Promise<GroupWorkInputReceipt>{
  ownerId(owner)
  const row=(await this.pool.query('select * from teloa_group_work_inputs where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','群工作追加回执不属于当前本人。')
  return receipt(row)
 }

 /** 待处理（已保存、待核对）的回执，供常驻驱动恢复；不重新登记。 */
 async pending(owner:string):Promise<GroupWorkInputRecord[]>{
  ownerId(owner)
  return (await this.pool.query("select * from teloa_group_work_inputs where owner_id=$1 and state in ('reserved','continued','unknown') order by created_at,request_id limit 50",[owner])).rows.map(row=>({...receipt(row),groupId:String(row.group_id),messageId:String(row.message_id),observedRunId:row.observed_run_id===null?null:String(row.observed_run_id),versioned:row.task_version!==null}))
 }

 /**
  * 完成后续办（规格 §4.4）：锁原任务，保留同一 taskId、新增任务版本并回到可准备状态；旧 Run、成果与审批不变。
  * 原 Run 仍在进行时保持已保存（在当前运行结束后续办）；登记之后又有别的运行介入或任务已取消时拒绝，不扩大范围。
  */
 async continueTask(owner:string,requestId:string):Promise<GroupWorkInputReceipt>{
  ownerId(owner)
  return this.transaction(async db=>{
   const row=(await db.query('select * from teloa_group_work_inputs where owner_id=$1 and request_id=$2 for update',[owner,requestId])).rows[0]
   if(!row)throw new WorkError('teloa/forbidden','群工作追加回执不属于当前本人。')
   // 只有尚未升版本的回执（已保存，或升版本前结果未知）走续办；已续办的只按原 Run 身份推进，不再升版本。
   if(row.operation!=='continue'||!(row.state==='reserved'||row.state==='unknown'&&row.task_version===null))return receipt(row)
   const task=(await db.query('select version,state,content_version from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,row.task_id])).rows[0]
   const latest=(await db.query('select id,state from teloa_task_runs where owner_id=$1 and task_id=$2 order by created_at desc,id desc limit 1',[owner,row.task_id])).rows[0]
   if(latest&&!settledRun.includes(String(latest.state)))return receipt(row)
   const reject=async(reason:string)=>receipt((await db.query("update teloa_group_work_inputs set state='rejected',reason=$3,updated_at=$4 where owner_id=$1 and request_id=$2 returning *",[owner,requestId,reason,this.identity.now()])).rows[0]!)
   if(!task||task.state==='cancelled')return reject('teloa/conflict')
   if((latest?.id??null)!==row.observed_run_id)return reject('teloa/version-conflict')
   // 排队期间本人改过目标或配置（内容版本变化）就不能把追加套到另一版目标上；正常运行推进只改状态版本，不在此拒绝。
   if(row.expected_content_version!==null&&task.content_version!==row.expected_content_version)return reject('teloa/version-conflict')
   // 停止之后不复活：登记之后本人又要求停止，或原工作控制已结束，续办拒绝；本人再次明确继续需要新的消息与控制世代。
   if((await db.query("select 1 from teloa_group_work_inputs where owner_id=$1 and task_id=$2 and operation='stop' and state<>'rejected' and created_at>=$3 and request_id<>$4 limit 1",[owner,row.task_id,row.created_at,requestId])).rowCount)return reject('teloa/conflict')
   const lineage=(await db.query('select lineage from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,row.task_id])).rows[0]?.lineage as {roundControlId?:unknown}|undefined
   const control=typeof lineage?.roundControlId==='string'?(await db.query('select state from teloa_work_controls where owner_id=$1 and id=$2',[owner,lineage.roundControlId])).rows[0]:undefined
   if(control&&control.state!=='active'){if(['ending','ended','stopping','stopped'].includes(String(control.state)))return reject('teloa/conflict');return receipt(row)}
   if(!['waiting','completed','blocked','paused','ready'].includes(String(task.state)))return receipt(row)
   const now=this.identity.now(),updated=(await db.query("update teloa_tasks set state='ready',version=version+1,updated_at=$3 where owner_id=$1 and id=$2 returning version",[owner,row.task_id,now])).rows[0]
   // 即时追加没被原 Run 受理（原 Run 已结束且原生日志里没有它）时转为续办：清掉原 Run 绑定，新 Run 另行记录。
   return receipt((await db.query("update teloa_group_work_inputs set state='continued',task_version=$3,run_id=null,native_request_id=null,accepted_seq=null,updated_at=$4 where owner_id=$1 and request_id=$2 returning *",[owner,requestId,updated!.version,now])).rows[0]!)
  })
 }

 /**
  * 分阶段回填（规格 §4.4）：continued 只记录续办 Run 身份；accepted 只在核实原 Run 已被原生受理（或停止已提交原控制）后写，
  * 同时固定原生请求身份；未知只记 unknown 并保留已知 Run 身份。迁移必须符合共享迁移表，绑定的 Run 身份一经写入不可更换。
  */
 async settle(owner:string,input:{requestId:string;state:Exclude<GroupWorkInputState,'reserved'>;runId:string|null;nativeRequestId?:string|null;acceptedSeq?:number|null;reason:string|null}):Promise<GroupWorkInputReceipt>{
  ownerId(owner)
  if(input.acceptedSeq!==undefined&&input.acceptedSeq!==null&&(input.state!=='accepted'||!Number.isSafeInteger(input.acceptedSeq)||input.acceptedSeq<0))throw new WorkError('teloa/invalid-input','原生接受序号只能随核实受理写入。')
  const from=(Object.keys(groupWorkInputTransitions) as GroupWorkInputState[]).filter(state=>groupWorkInputTransitions[state].includes(input.state))
  const row=(await this.pool.query(`update teloa_group_work_inputs set state=$3,run_id=coalesce(run_id,$4),native_request_id=coalesce(native_request_id,$5),accepted_seq=coalesce(accepted_seq,$9),reason=$6,updated_at=$7
   where owner_id=$1 and request_id=$2 and state=any($8::text[]) and (run_id is null or $4::uuid is null or run_id=$4) and (native_request_id is null or $5::text is null or native_request_id=$5) returning *`,[owner,input.requestId,input.state,input.runId,input.nativeRequestId??null,input.reason,this.identity.now(),from,input.acceptedSeq??null])).rows[0]
  if(!row)return this.get(owner,input.requestId)
  return receipt(row)
 }
}

/**
 * 活动 Run 即时追加的目标（规格 §4.4）：回执仍是已保存的追加、原任务最近一次 Run 已被原生受理且仍在处理、
 * 追加消息不带新的资料/附件/成果引用时，才可经原生受控输入送进原 Run；带新资料的追加不热扩活动 Run 的范围，
 * 等原 Run 收敛后按新任务版本续办。
 */
export async function readGroupRunAppendTarget(db:Database,owner:string,requestId:string):Promise<{runId:string;sessionId:string;text:string}|null>{
 const row=(await db.query(`select i.*,m.text,m.reference_snapshot from teloa_group_work_inputs i join teloa_group_messages m on m.id=i.message_id and m.group_id=i.group_id and m.owner_id=i.owner_id
  where i.owner_id=$1 and i.request_id=$2`,[owner,requestId])).rows[0]
 if(!row||row.operation!=='continue'||row.state!=='reserved'||row.native_request_id!==null)return null
 const references=normalizeReferences(row.reference_snapshot)
 if(!Array.isArray(references)||references.length)return null
 const run=(await db.query('select id,session_id,state from teloa_task_runs where owner_id=$1 and task_id=$2 order by created_at desc,id desc limit 1',[owner,row.task_id])).rows[0]
 if(!run||!['accepted','active'].includes(String(run.state))||run.id!==row.observed_run_id)return null
 return {runId:String(run.id),sessionId:String(run.session_id),text:String(row.text)}
}

/** 某原 Run 会话里由本宿主登记过的群追加原生请求身份（待核对或已受理），供运行观察、工具守卫与冷恢复识别同一冻结范围。 */
export async function readGroupRunAppendIds(db:Database,owner:string,sessionId:string):Promise<string[]>{
 return (await db.query(`select i.native_request_id from teloa_group_work_inputs i join teloa_task_runs r on r.owner_id=i.owner_id and r.id=i.run_id
  where i.owner_id=$1 and r.session_id=$2 and i.task_version is null and i.native_request_id is not null and i.state in ('unknown','accepted')`,[owner,sessionId])).rows.map(row=>String(row.native_request_id))
}

/** 续办 Run 的追加来源：只认已送达、且绑定到该任务版本的那一条；不同版本的 Run 读不到彼此的追加。 */
export async function readGroupWorkContinuation(db:Database,owner:string,taskId:string,taskVersion:number):Promise<GroupWorkContinuation|undefined>{
 // 续办 Run 在 continued 阶段准备：只要回执已为该任务版本升版本（且未被拒绝），新 Run 就读这一条追加。
 const row=(await db.query(`select m.id,m.text,m.created_at,m.reference_snapshot from teloa_group_work_inputs i join teloa_group_messages m on m.id=i.message_id and m.group_id=i.group_id and m.owner_id=i.owner_id
  where i.owner_id=$1 and i.task_id=$2 and i.task_version=$3 and i.operation='continue' and i.state in ('continued','accepted','unknown')`,[owner,taskId,taskVersion])).rows[0]
 if(!row)return undefined
 // 追加消息里的资料、附件与成果按原消息固定版本随来源进入新 Run；是否可读仍由本群对该员工的授权决定，不因引用而扩权。
 const references=normalizeReferences(row.reference_snapshot)
 if(!Array.isArray(references)||!references.every(isMessageReference))throw corrupt()
 return {messageId:String(row.id),text:String(row.text),createdAt:(row.created_at as Date).toISOString(),references:references.map(reference=>({...reference}))}
}
