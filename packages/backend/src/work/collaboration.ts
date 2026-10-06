import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {workAccess} from './work-access.ts'
import {assertBusinessScopeRegistered} from './business-scopes.ts'
import {WorkError,roleSupportsScope,groupChangeInput,groupCreateInput,groupDefinition,groupListInput,groupMessageListInput,groupResourceGetInput,groupResourceListInput,groupResourceSaveInput,groupResourceWithdrawInput,groupSendInput,isGroup,isGroupMember,isGroupMessage,isGroupResource,isGroupResourceVersion,roleDefinition,type Group,type GroupChangeInput,type GroupDefinition,type GroupMember,type GroupMention,type GroupMessage,type GroupResource,type GroupResourceSaveInput,type GroupResourceVersion,type GroupResourceWithdrawInput,type DigitalRole,normalizeReferences,type GroupSendInput,type MessageReference} from '@teloa/contract'
import {readActiveAttachment} from './group-attachments.ts'
import {readGroupAgentGrant} from './group-agent-grants.ts'
import {readStoredRole} from './roles.ts'

/** 只保证这个值能进 uuid 列，不限版本位与变体位（与 `group-run-messages.ts:9` 同口径）。 */
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
/** 三种 kind 的不可见共用这一句：按 kind 分文案会让 message 本身成为存在性探测口，三支必须逐字相同。 */
const referenceInvisible='引用的原件不存在、已撤回或不属于当前本人。'
/**
 * T5 默认签发入库的时刻：此后建的群在建群与改成员那一笔里已经签过，补签只针对更早的群（2026-09-21 编排者裁定）。
 * 有了这道界，重启就不再是常态化的授权触发点。
 */
export const groupGrantBackfillCutoff='2026-09-21T12:30:00.000Z' // 3100 宿主带默认签发（T5，3510e9c 17:51+08）重启于 2026-09-21 20:14+08，此后建的群在建群那一笔已签

/**
 * 同一位员工在同一个群里的默认授权身份恒定：重放不会签出第二条。
 * 派生形状照 `auto-dream-plans.ts:14-17`（版本位 `5`、变体位 `a`）。
 */
function defaultGrantRequestId(owner:string,groupId:string,roleId:string):string{
  const value=createHash('sha256').update(['teloa/group-member-default-grant/v1',owner,groupId,roleId].join('\0')).digest('hex')
  return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}

/**
 * 群版本变化时的续签身份：同一位员工在同一个群版本上只可能续出一行，重放群编辑不签第二条。
 * 与 `defaultGrantRequestId` 同一 `shape()` 式，多一个群版本分量（默认签发与续签因此永不撞 `unique(owner_id,request_id)`）。
 */
function renewedGrantRequestId(owner:string,groupId:string,roleId:string,groupVersion:number):string{
  const value=createHash('sha256').update(['teloa/group-member-grant-renewal/v1',owner,groupId,roleId,String(groupVersion)].join('\0')).digest('hex')
  return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}

/**
 * 岗位版本变化时的续签身份：同一位员工在同一个群、同一个岗位版本上只可能续出一行，重放改岗位不签第二条。
 * 与 `renewedGrantRequestId` 同一 `shape()` 式，但分量是**岗位版本**而不是群版本：
 * 直接复用那条会在「同一个群版本上先后改两次岗位」时撞 `unique(owner_id,request_id)`，
 * 而契约与既有派生一律不动，所以这里另起一条只属于岗位续签的内部派生。
 */
function roleRenewedGrantRequestId(owner:string,groupId:string,roleId:string,roleVersion:number):string{
  const value=createHash('sha256').update(['teloa/group-role-grant-renewal/v1',owner,groupId,roleId,String(roleVersion)].join('\0')).digest('hex')
  return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}

function ownerId(value:string):void{
  if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
}

function stamp(value:unknown):string{
  if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw new WorkError('teloa/storage-corrupt','群协作记录时间损坏。')
  return value.toISOString()
}

function readGroup(row:Record<string,unknown>):Group{
  try{
    const fields=groupDefinition(row.definition)
    const value={id:row.id,ownerId:row.owner_id,version:row.version,name:fields.name,scope:fields.scope,announcement:fields.announcement,rules:fields.rules,pinned:row.pinned,archived:row.archived,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
    if(!isGroup(value))throw Error('invalid group')
    return value
  }catch{
    throw new WorkError('teloa/storage-corrupt','群定义记录损坏，已停止读取。')
  }
}

function readMessage(row:Record<string,unknown>):GroupMessage{
  try{
    const base={id:row.id,groupId:row.group_id,rootId:row.root_id,authorId:row.author_id,text:row.text,references:normalizeReferences(row.reference_snapshot),createdAt:stamp(row.created_at)}
    const value=base.authorId==='self'?{...base,mentions:row.mention_snapshot}:{...base,taskId:row.task_id,runId:row.run_id}
    if(!isGroupMessage(value))throw Error('invalid message')
    return value
  }catch{
    throw new WorkError('teloa/storage-corrupt','群消息记录损坏，已停止读取。')
  }
}

function readMember(row:Record<string,unknown>):GroupMember{
  try{
    const value={groupId:row.group_id,roleId:row.role_id,createdAt:stamp(row.created_at)}
    if(!isGroupMember(value))throw Error('invalid group member')
    return value
  }catch{
    throw new WorkError('teloa/storage-corrupt','群成员记录损坏，已停止读取。')
  }
}

function readResource(row:Record<string,unknown>):GroupResource{
  try{
    const value={id:row.id,groupId:row.group_id,ownerId:row.owner_id,version:row.version,title:row.title,withdrawnAt:row.withdrawn_at===null?null:stamp(row.withdrawn_at),createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
    if(!isGroupResource(value))throw Error('invalid group resource')
    return value
  }catch{
    throw new WorkError('teloa/storage-corrupt','群资料记录损坏，已停止读取。')
  }
}

function readResourceVersion(row:Record<string,unknown>):GroupResourceVersion{
  try{
    const value={resourceId:row.resource_id,groupId:row.group_id,version:row.version,title:row.title,markdown:row.markdown,createdAt:stamp(row.created_at)}
    if(!isGroupResourceVersion(value))throw Error('invalid group resource version')
    return value
  }catch{
    throw new WorkError('teloa/storage-corrupt','群资料版本记录损坏，已停止读取。')
  }
}

function groupGetInput(input:unknown):{groupId:string}{
  const request=groupMessageListInput(input)
  if(request.rootId!==undefined)throw new WorkError('teloa/invalid-input','群详情不接受消息根记录。')
  return request
}

function changeSpec(input:GroupChangeInput):string{return JSON.stringify(input)}
function sendSpec(input:GroupSendInput):string{return JSON.stringify(input)}
function resourceSaveSpec(input:GroupResourceSaveInput):string{return JSON.stringify(input)}
function resourceWithdrawSpec(input:GroupResourceWithdrawInput):string{return JSON.stringify(input)}

export async function initializeCollaboration(pool:Pool):Promise<void>{
  await pool.query(`
    create unique index if not exists teloa_roles_identity_owner on teloa_roles(id,owner_id);
    create table if not exists teloa_groups (
      id uuid primary key, owner_id text not null, request_id uuid not null,
      request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
      definition jsonb not null check(jsonb_typeof(definition)='object'),
      version integer not null check(version>0), pinned boolean not null, archived boolean not null,
      created_at timestamptz not null, updated_at timestamptz not null,
      unique(owner_id,request_id), unique(id,owner_id)
    );
    create table if not exists teloa_group_members (
      group_id uuid not null, owner_id text not null, member_key text not null,
      role_id uuid, created_at timestamptz not null,
      primary key(group_id,member_key),
      foreign key(group_id,owner_id) references teloa_groups(id,owner_id) on delete cascade,
      foreign key(role_id,owner_id) references teloa_roles(id,owner_id),
      check((member_key='self')=(role_id is null)),
      check(role_id is null or member_key=role_id::text)
    );
    create table if not exists teloa_group_change_requests (
      owner_id text not null, request_id uuid not null, group_id uuid not null,
      request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
      result jsonb not null check(jsonb_typeof(result)='object'), created_at timestamptz not null,
      primary key(owner_id,request_id), unique(group_id,request_id)
    );
    create table if not exists teloa_group_messages (
      id uuid primary key, owner_id text not null, group_id uuid not null, request_id uuid not null,
      request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
      root_id uuid, author_id text not null check(author_id='self'), text text not null,
      reference_snapshot jsonb not null check(jsonb_typeof(reference_snapshot)='array'), created_at timestamptz not null,
      unique(owner_id,request_id), unique(id,group_id),
      foreign key(group_id,owner_id) references teloa_groups(id,owner_id) on delete cascade,
      foreign key(root_id) references teloa_group_messages(id),
      check(root_id is null or root_id<>id)
    );
    alter table teloa_group_messages add column if not exists task_id uuid;
    alter table teloa_group_messages add column if not exists run_id uuid;
    do $$ begin
      if exists(select 1 from pg_constraint where conrelid='teloa_group_messages'::regclass and conname='teloa_group_messages_author_id_check') then
        alter table teloa_group_messages drop constraint teloa_group_messages_author_id_check;
      end if;
      if not exists(select 1 from pg_constraint where conrelid='teloa_group_messages'::regclass and conname='teloa_group_messages_author_execution_v1') then
        alter table teloa_group_messages add constraint teloa_group_messages_author_execution_v1 check(
          (author_id='self' and task_id is null and run_id is null) or
          (author_id<>'self' and task_id is not null and run_id is not null)
        );
      end if;
    end $$;
    create index if not exists teloa_group_message_topic_v1 on teloa_group_messages(owner_id,group_id,root_id,created_at,id);
    create table if not exists teloa_group_resources (
      id uuid primary key, owner_id text not null, group_id uuid not null,
      version integer not null check(version>0), title text not null check(length(title) between 1 and 120),
      withdrawn_at timestamptz, created_at timestamptz not null, updated_at timestamptz not null,
      unique(id,owner_id,group_id),
      foreign key(group_id,owner_id) references teloa_groups(id,owner_id) on delete cascade
    );
    create table if not exists teloa_group_resource_versions (
      resource_id uuid not null, owner_id text not null, group_id uuid not null,
      version integer not null check(version>0), title text not null check(length(title) between 1 and 120),
      markdown text not null check(length(markdown) between 1 and 16000), created_at timestamptz not null,
      primary key(resource_id,version),
      foreign key(resource_id,owner_id,group_id) references teloa_group_resources(id,owner_id,group_id) on delete cascade
    );
    create table if not exists teloa_group_resource_requests (
      owner_id text not null, request_id uuid not null, group_id uuid not null, resource_id uuid not null,
      request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
      result jsonb not null check(jsonb_typeof(result)='object'), created_at timestamptz not null,
      primary key(owner_id,request_id), unique(resource_id,request_id),
      foreign key(resource_id,owner_id,group_id) references teloa_group_resources(id,owner_id,group_id) on delete cascade
    );
    alter table teloa_group_messages add column if not exists mention_snapshot jsonb not null default '[]'::jsonb;
  `)
}

export class CollaborationService{
  readonly pool:Pool
  readonly identity:{id:()=>string;now:()=>string}

  constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}

  async list(owner:string,input:unknown):Promise<Group[]>{
    ownerId(owner)
    groupListInput(input)
    return (await this.pool.query('select * from teloa_groups where owner_id=$1 order by pinned desc,updated_at desc,id',[owner])).rows.map(readGroup)
  }

  async get(owner:string,input:unknown):Promise<{group:Group;members:GroupMember[]}>{
    ownerId(owner)
    const request=groupGetInput(input),client=await this.pool.connect()
    try{
      await client.query('begin')
      const found=await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for share',[request.groupId,owner])
      if(!found.rows[0])throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
      const group=readGroup(found.rows[0])
      const members=(await client.query('select group_id,role_id,created_at from teloa_group_members where group_id=$1 and owner_id=$2 order by created_at,member_key',[group.id,owner])).rows.map(readMember)
      if(members.length===0||members.filter(member=>member.roleId===null).length!==1)throw new WorkError('teloa/storage-corrupt','群成员记录损坏，未找到唯一的本人成员。')
      await client.query('commit')
      return {group,members}
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  async create(owner:string,input:unknown):Promise<Group>{
    ownerId(owner)
    const request=groupCreateInput(input),spec=JSON.stringify(request.fields),client=await this.pool.connect()
    try{
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-create',owner,request.requestId])])
      const existing=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_groups where owner_id=$1 and request_id=$2 for update',[owner,request.requestId,spec])
      if(existing.rows[0]){
        if(!existing.rows[0].same_request)throw new WorkError('teloa/conflict','同一请求不能创建不同群。')
        const group=readGroup(existing.rows[0])
        await client.query('commit')
        return group
      }
      // 业务范围必须已登记在标签表（规格 §3.2）；判据在任何写之前，未登记时整笔事务不留痕迹。
      await assertBusinessScopeRegistered(client,owner,request.fields.scope)
      await this.validateMembers(client,owner,request.fields.memberRoleIds)
      const id=this.identity.id(),now=this.identity.now()
      const admission=await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:id,operation:'create'})
      admission.assertCurrent()
      const saved=await client.query("insert into teloa_groups(id,owner_id,request_id,request_spec,definition,version,pinned,archived,created_at,updated_at) values($1,$2,$3,$4,$4,1,false,false,$5,$5) returning *",[id,owner,request.requestId,spec,now])
      const group=readGroup(saved.rows[0])
      await this.replaceMembers(client,owner,group,request.fields.memberRoleIds,now)
      admission.assertCurrent()
      await client.query('commit')
      return group
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  async change(owner:string,input:unknown):Promise<Group>{
    ownerId(owner)
    const request=groupChangeInput(input),spec=changeSpec(request),client=await this.pool.connect()
    try{
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-change',owner,request.requestId])])
      const prior=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_group_change_requests where owner_id=$1 and request_id=$2',[owner,request.requestId,spec])
      if(prior.rows[0]){
        if(!prior.rows[0].same_request)throw new WorkError('teloa/conflict','同一群编辑请求不能更换内容。')
        const result=prior.rows[0].result
        if(!isGroup(result)||result.ownerId!==owner||result.id!==request.groupId||result.version!==request.expectedVersion+1)throw new WorkError('teloa/storage-corrupt','群编辑回执损坏，已停止重试。')
        await client.query('commit')
        return result
      }
      const found=await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for update',[request.groupId,owner])
      if(!found.rows[0])throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
      const current=readGroup(found.rows[0])
      if(current.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','群设置已变化，请刷新后核对。')
      await this.validateMembers(client,owner,request.fields.memberRoleIds)
      const definition:GroupDefinition={name:request.fields.name,scope:current.scope,announcement:request.fields.announcement,rules:{...request.fields.rules},memberRoleIds:[...request.fields.memberRoleIds]}
      const now=this.identity.now()
      const admission=await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:current.id,operation:'edit'})
      admission.assertCurrent()
      const saved=await client.query('update teloa_groups set definition=$3,version=version+1,pinned=$4,archived=$5,updated_at=$6 where id=$1 and owner_id=$2 returning *',[current.id,owner,JSON.stringify(definition),request.fields.pinned,request.fields.archived,now])
      const group=readGroup(saved.rows[0])
      await this.replaceMembers(client,owner,group,request.fields.memberRoleIds,now)
      // 取消归档的那一笔把全体成员补过一遍：归档期间加进来的人在当时被整段跳过，差集此后再也认不出他们。
      if(current.archived&&!group.archived)await this.grantMembers(client,owner,group,[...new Set(request.fields.memberRoleIds)],now)
      // 群版本 +1 会让既有授权行整体判 `invalidated`（`group-agent-grants.ts:113`）：不续签的话，一次改群名就让「直接回应」全体停摆。
      await this.renewMemberGrants(client,owner,group,request.fields.memberRoleIds,now)
      await client.query('insert into teloa_group_change_requests(owner_id,request_id,group_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,request.requestId,group.id,spec,JSON.stringify(group),now])
      admission.assertCurrent()
      await client.query('commit')
      return group
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  async send(owner:string,input:unknown):Promise<GroupMessage>{
    ownerId(owner)
    const request=groupSendInput(input),spec=sendSpec(request),client=await this.pool.connect()
    try{
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-send',owner,request.requestId])])
      const prior=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_group_messages where owner_id=$1 and request_id=$2',[owner,request.requestId,spec])
      if(prior.rows[0]){
        if(!prior.rows[0].same_request)throw new WorkError('teloa/conflict','同一消息请求不能更换内容。')
        const message=readMessage(prior.rows[0])
        await client.query('commit')
        return message
      }
      const found=await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for share',[request.groupId,owner])
      if(!found.rows[0])throw new WorkError('teloa/forbidden','不能向非本人群发送消息。')
      const group=readGroup(found.rows[0])
      if(group.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','群设置已变化，请刷新后再发送。')
      if(group.archived)throw new WorkError('teloa/conflict','已归档群不能发送新消息。')
      if(request.rootId!==undefined)await this.assertRoot(client,owner,group.id,request.rootId)
      await this.assertReferences(client,owner,group.id,request.references??[])
      await this.assertMentions(client,owner,group.id,request.mentions??[])
      const admission=await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:group.id,operation:'run'})
      admission.assertCurrent()
      const now=this.identity.now(),saved=await client.query("insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,mention_snapshot,created_at) values($1,$2,$3,$4,$5,$6,'self',$7,$8,$9,$10) returning *",[this.identity.id(),owner,group.id,request.requestId,spec,request.rootId??null,request.text,JSON.stringify(request.references??[]),JSON.stringify(request.mentions??[]),now])
      const message=readMessage(saved.rows[0])
      admission.assertCurrent()
      await client.query('commit')
      return message
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  async messages(owner:string,input:unknown):Promise<GroupMessage[]>{
    ownerId(owner)
    const request=groupMessageListInput(input),client=await this.pool.connect()
    try{
      await client.query('begin')
      const found=await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for share',[request.groupId,owner])
      if(!found.rows[0])throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
      if(request.rootId!==undefined){
        await this.assertRoot(client,owner,request.groupId,request.rootId)
        const rows=await client.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and (id=$3 or root_id=$3) order by (id=$3) desc,created_at,id',[owner,request.groupId,request.rootId])
        await client.query('commit')
        return rows.rows.map(readMessage)
      }
      const rows=await client.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 order by created_at,id',[owner,request.groupId])
      await client.query('commit')
      return rows.rows.map(readMessage)
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  async resources(owner:string,input:unknown):Promise<GroupResource[]>{
    ownerId(owner)
    const request=groupResourceListInput(input),client=await this.pool.connect()
    try{
      await client.query('begin')
      await this.assertGroupReadable(client,owner,request.groupId)
      const rows=await client.query('select * from teloa_group_resources where owner_id=$1 and group_id=$2 order by withdrawn_at nulls first,updated_at desc,id',[owner,request.groupId])
      await client.query('commit')
      return rows.rows.map(readResource)
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  async resource(owner:string,input:unknown):Promise<GroupResourceVersion>{
    ownerId(owner)
    const request=groupResourceGetInput(input),client=await this.pool.connect()
    try{
      await client.query('begin')
      await this.assertGroupReadable(client,owner,request.groupId)
      const found=await client.query('select resource_id,group_id,version,title,markdown,created_at from teloa_group_resource_versions where resource_id=$1 and owner_id=$2 and group_id=$3 and version=$4 for share',[request.resourceId,owner,request.groupId,request.resourceVersion])
      if(!found.rows[0])throw new WorkError('teloa/forbidden','群资料版本不存在或不属于当前本人群。')
      const result=readResourceVersion(found.rows[0])
      await client.query('commit')
      return result
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  async saveResource(owner:string,input:unknown):Promise<GroupResource>{
    ownerId(owner)
    const request=groupResourceSaveInput(input),spec=resourceSaveSpec(request),client=await this.pool.connect()
    try{
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-resource-save',owner,request.requestId])])
      const prior=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_group_resource_requests where owner_id=$1 and request_id=$2 for update',[owner,request.requestId,spec])
      if(prior.rows[0]){
        if(!prior.rows[0].same_request)throw new WorkError('teloa/conflict','同一群资料保存请求不能更换内容。')
        const result=prior.rows[0].result
        if(!isGroupResource(result)||result.ownerId!==owner||result.groupId!==request.groupId||result.id!==request.resourceId)throw new WorkError('teloa/storage-corrupt','群资料保存回执损坏，已停止重试。')
        await client.query('commit')
        return result
      }
      const group=await this.assertGroupWritable(client,owner,request.groupId)
      const found=await client.query('select * from teloa_group_resources where id=$1 for update',[request.resourceId])
      const current=found.rows[0]
      const now=this.identity.now()
      let result:GroupResource
      if(!current){
        if(request.expectedVersion!==0)throw new WorkError('teloa/forbidden','群资料不存在，不能修订。')
        const saved=await client.query('insert into teloa_group_resources(id,owner_id,group_id,version,title,withdrawn_at,created_at,updated_at) values($1,$2,$3,1,$4,null,$5,$5) returning *',[request.resourceId,owner,group.id,request.title,now])
        await client.query('insert into teloa_group_resource_versions(resource_id,owner_id,group_id,version,title,markdown,created_at) values($1,$2,$3,1,$4,$5,$6)',[request.resourceId,owner,group.id,request.title,request.markdown,now])
        result=readResource(saved.rows[0])
      }else{
        const existing=readResource(current)
        if(existing.ownerId!==owner||existing.groupId!==group.id)throw new WorkError('teloa/forbidden','群资料不属于当前本人群。')
        if(existing.withdrawnAt!==null)throw new WorkError('teloa/conflict','已撤回资料不能继续修订。')
        if(existing.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','群资料已变化，请刷新后核对。')
        const nextVersion=existing.version+1
        const saved=await client.query('update teloa_group_resources set version=$4,title=$5,updated_at=$6 where id=$1 and owner_id=$2 and group_id=$3 returning *',[existing.id,owner,group.id,nextVersion,request.title,now])
        await client.query('insert into teloa_group_resource_versions(resource_id,owner_id,group_id,version,title,markdown,created_at) values($1,$2,$3,$4,$5,$6,$7)',[existing.id,owner,group.id,nextVersion,request.title,request.markdown,now])
        result=readResource(saved.rows[0])
      }
      await client.query('insert into teloa_group_resource_requests(owner_id,request_id,group_id,resource_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6,$7)',[owner,request.requestId,group.id,result.id,spec,JSON.stringify(result),now])
      await client.query('commit')
      return result
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  async withdrawResource(owner:string,input:unknown):Promise<GroupResource>{
    ownerId(owner)
    const request=groupResourceWithdrawInput(input),spec=resourceWithdrawSpec(request),client=await this.pool.connect()
    try{
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-resource-withdraw',owner,request.requestId])])
      const prior=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_group_resource_requests where owner_id=$1 and request_id=$2 for update',[owner,request.requestId,spec])
      if(prior.rows[0]){
        if(!prior.rows[0].same_request)throw new WorkError('teloa/conflict','同一群资料撤回请求不能更换内容。')
        const result=prior.rows[0].result
        if(!isGroupResource(result)||result.ownerId!==owner||result.groupId!==request.groupId||result.id!==request.resourceId||result.withdrawnAt===null)throw new WorkError('teloa/storage-corrupt','群资料撤回回执损坏，已停止重试。')
        await client.query('commit')
        return result
      }
      const group=await this.assertGroupWritable(client,owner,request.groupId)
      const found=await client.query('select * from teloa_group_resources where id=$1 for update',[request.resourceId])
      if(!found.rows[0])throw new WorkError('teloa/forbidden','群资料不存在或不属于当前本人群。')
      const current=readResource(found.rows[0])
      if(current.ownerId!==owner||current.groupId!==group.id)throw new WorkError('teloa/forbidden','群资料不属于当前本人群。')
      if(current.withdrawnAt!==null)throw new WorkError('teloa/conflict','群资料已撤回。')
      if(current.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','群资料已变化，请刷新后核对。')
      const now=this.identity.now(),saved=await client.query('update teloa_group_resources set withdrawn_at=$4,updated_at=$4 where id=$1 and owner_id=$2 and group_id=$3 returning *',[current.id,owner,group.id,now])
      const result=readResource(saved.rows[0])
      await client.query('insert into teloa_group_resource_requests(owner_id,request_id,group_id,resource_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6,$7)',[owner,request.requestId,group.id,result.id,spec,JSON.stringify(result),now])
      await client.query('commit')
      return result
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
  }

  /**
   * 给 `groupGrantBackfillCutoff` 之前建的群补签默认授权（2026-09-21 用户裁定）：默认签发只在建群与改成员那一笔跑，
   * 更早建的群一行授权都没有，群里发消息因此恒判 `no-candidate`。每群的员工成员走既有 `grantMembers`——
   * 它对「已有任何一版授权行」「分身 / 非在岗 / 范围不支持」一律跳过，所以重复调用不会签出第二行、也不复活已撤销的那一版。
   * **一群一个事务**：一个群补不上不该把其余群一起回滚，失败只经 `report` 记一行告警（只给群身份与错误码，不给群内正文）。
   * 外层列表不加锁，锁在每群的事务里按 groups→members/roles→grants 取，与群编辑同序。返回本次实际签出的行数。
   */
  async backfillDefaultGrants(owner:string,report?:(groupId:string,code:string)=>void):Promise<number>{
    ownerId(owner)
    const pending=(await this.pool.query('select id from teloa_groups where owner_id=$1 and archived=false and created_at<$2::timestamptz order by created_at',[owner,groupGrantBackfillCutoff])).rows.map(row=>String(row.id))
    let signed=0
    for(const groupId of pending){
      const client=await this.pool.connect()
      try{
        await client.query('begin')
        // 外层读过之后被删掉或归档的群在这里自然落空：不存在与已归档都跳过，不当作失败。
        const row=(await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for update',[groupId,owner])).rows[0]
        let count=0
        if(row&&row.archived===false){
          const group=readGroup(row)
          // 成员表里有一行 member_key='self' 且 role_id 为 null；按群成员取员工的查询一律带 role_id is not null。
          const members=await client.query('select role_id from teloa_group_members where group_id=$1 and owner_id=$2 and role_id is not null for update',[groupId,owner])
          count=await this.grantMembers(client,owner,group,members.rows.map(member=>String(member.role_id)),this.identity.now())
        }
        await client.query('commit')
        signed+=count
      }catch(error){
        await client.query('rollback')
        report?.(groupId,error instanceof WorkError?error.code:'teloa/storage-unavailable')
      }finally{client.release()}
    }
    return signed
  }

  private async validateMembers(client:PoolClient,owner:string,roleIds:readonly string[]):Promise<void>{
    for(const roleId of roleIds){
      const found=await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for share',[roleId,owner])
      if(!found.rows[0])throw new WorkError('teloa/forbidden','群成员员工不存在或不属于当前本人。')
      // 群成员可来自任何业务范围（2026-09-21 用户裁定 B）：只保留岗位归属、定义完整性与在岗判据，范围只在建任务时校验。
      try{roleDefinition(found.rows[0].definition)}catch{throw new WorkError('teloa/storage-corrupt','群成员员工定义损坏，不能加入协作群。')}
      if(found.rows[0].state!=='active')throw new WorkError('teloa/conflict','只有在岗员工可以加入协作群。')
    }
  }

  /**
   * 拉员工进群默认允许直接回应（规格 §2.5 的 C1）：成员写口是全量替换，所以「本次新增」必须在 `replaceMembers` 删成员之前算。
   * 只给本次新增里此前从未有过授权行的 roleId 签一版 `{resources:[],canPost:true,canAutoRun:true}`；
   * 有行一律跳过——既不覆盖本人自己调过的授权，也不复活已撤销的那一版。移出成员不动它的授权行。
   */
  private async grantNewMembers(client:PoolClient,owner:string,group:Group,roleIds:readonly string[],now:string):Promise<void>{
    // 已归档群不新增AI 员工授权（与 `group-agent-grants.ts` 的 save 判据同口径），但不因此挡住群编辑本身。
    // 归档期间加进来的成员会被整段跳过，`change()` 在取消归档的那一笔把全体成员补过一遍。
    if(group.archived)return
    // 成员表里有一行 member_key='self' 且 role_id 为 null；按群成员取员工的查询一律带 role_id is not null。
    const current=await client.query('select role_id from teloa_group_members where group_id=$1 and owner_id=$2 and role_id is not null for update',[group.id,owner])
    const existing=new Set(current.rows.map(row=>String(row.role_id)))
    await this.grantMembers(client,owner,group,[...new Set(roleIds)].filter(roleId=>!existing.has(roleId)),now)
  }

  /**
   * 逐个签发默认授权：已有任何一版授权行（含 `revoked`）一律跳过。
   * 跳过判据与 `task-run-group-context.ts:115` 同四项（岗位类型、在岗、业务范围、群本身可用）——
   * 签不出能跑的运行的行不如不签。范围一项走契约判据 `roleSupportsScope`：通用工作群对任何范围的员工都开放（2026-09-21 用户裁定）。
   * 返回本次实际签出的行数，只给 `backfillDefaultGrants` 报数用。
   */
  private async grantMembers(client:PoolClient,owner:string,group:Group,roleIds:readonly string[],now:string):Promise<number>{
    let signed=0
    for(const roleId of roleIds){
      const found=await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for share',[roleId,owner])
      const role=readStoredRole(found.rows[0])
      // 分身永远不能执行群任务（`task-run-group-context.ts:115`），默认授权对它没有落点；
      // `state` 这一条是冗余防御，`validateMembers` 已经先拒过非在岗岗位。
      if(role.kind!=='employee'||role.state!=='active'||!roleSupportsScope(role.scopes,group.scope))continue
      const previous=await client.query('select grant_version from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version desc limit 1 for update',[group.id,roleId])
      if(previous.rows[0])continue
      const spec=JSON.stringify({groupId:group.id,roleId,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
      const inserted=await client.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
        values($1,$2,$3,1,$4,$5,'active','[]'::jsonb,true,true,$6,$7,$8) on conflict(group_id,role_id,grant_version) do nothing`,[group.id,owner,roleId,group.version,role.version,defaultGrantRequestId(owner,group.id,roleId),spec,now])
      signed+=inserted.rowCount??0
    }
    return signed
  }

  /**
   * 群版本变化时按新版本续签既有授权：改群名、改群规则、改成员都会 `group_version+1`，
   * 而 `group-agent-grants.ts:113` 的 `status()` 拿 `grant.groupVersion!==context.groupVersion` 判 `invalidated`，
   * 于是路由候选集（要 `canAutoRun` 且 `canPost` 且 `active`）一次群编辑就整体清空。
   * 只对写入后仍是成员、且最新一版是 `active` 的员工续一行，`resources`/`canPost`/`canAutoRun` 逐字沿用；
   * `revoked` 不复活；最新一版已经落在新群版本上的（本次刚默认签发的新成员、或本人手动保存过的）跳过——
   * 默认签发与续签因此互斥：前者只在「一行都没有」时插，后者只在「有行且 active」时插。
   */
  private async renewMemberGrants(client:PoolClient,owner:string,group:Group,roleIds:readonly string[],now:string):Promise<void>{
    // 已归档群不新增AI 员工授权（与 `group-agent-grants.ts` 的 save 判据同口径）；取消归档的那一笔群版本照样 +1，届时补上。
    if(group.archived)return
    for(const roleId of [...new Set(roleIds)]){
      const previous=(await client.query('select * from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version desc limit 1 for update',[group.id,roleId])).rows[0]
      if(!previous)continue
      const grant=readGroupAgentGrant(previous)
      if(grant.state!=='active'||grant.groupVersion===group.version)continue
      const found=await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for share',[roleId,owner])
      const role=readStoredRole(found.rows[0])
      // 与 `grantMembers` 同四项判据：签不出能跑的运行的行不如不签。
      if(role.kind!=='employee'||role.state!=='active'||!roleSupportsScope(role.scopes,group.scope))continue
      const resources=JSON.stringify(grant.resources)
      const spec=JSON.stringify({groupId:group.id,roleId,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:grant.resources,canPost:grant.canPost,canAutoRun:grant.canAutoRun})
      await client.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
        values($1,$2,$3,$4,$5,$6,'active',$7::jsonb,$8,$9,$10,$11,$12) on conflict(group_id,role_id,grant_version) do nothing`,[group.id,owner,roleId,grant.grantVersion+1,group.version,role.version,resources,grant.canPost,grant.canAutoRun,renewedGrantRequestId(owner,group.id,roleId,group.version),spec,now])
    }
  }

  private async replaceMembers(client:PoolClient,owner:string,group:Group,roleIds:readonly string[],now:string):Promise<void>{
    // 差集必须在 delete 之前算：这里是全量替换，删完就再也认不出「本次新增的是谁」。
    await this.grantNewMembers(client,owner,group,roleIds,now)
    await client.query('delete from teloa_group_members where group_id=$1 and owner_id=$2',[group.id,owner])
    await client.query("insert into teloa_group_members(group_id,owner_id,member_key,role_id,created_at) values($1,$2,'self',null,$3)",[group.id,owner,now])
    for(const roleId of roleIds)await client.query('insert into teloa_group_members(group_id,owner_id,member_key,role_id,created_at) values($1,$2,$3::text,$3::uuid,$4)',[group.id,owner,roleId,now])
  }

  private async assertRoot(client:PoolClient,owner:string,groupId:string,rootId:string):Promise<void>{
    const found=await client.query('select id,owner_id,group_id,root_id from teloa_group_messages where id=$1 for share',[rootId])
    const root=found.rows[0]
    if(!root||root.owner_id!==owner||root.group_id!==groupId)throw new WorkError('teloa/forbidden','消息根记录不属于当前本人群。')
    if(root.root_id!==null)throw new WorkError('teloa/conflict','回复必须引用同群根消息，不能嵌套引用回复。')
  }

  private async assertGroupReadable(client:PoolClient,owner:string,groupId:string):Promise<Group>{
    const found=await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for share',[groupId,owner])
    if(!found.rows[0])throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
    return readGroup(found.rows[0])
  }

  private async assertGroupWritable(client:PoolClient,owner:string,groupId:string):Promise<Group>{
    const found=await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for update',[groupId,owner])
    if(!found.rows[0])throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
    const group=readGroup(found.rows[0])
    if(group.archived)throw new WorkError('teloa/conflict','已归档群不能维护资料。')
    return group
  }

  /**
   * 权限在原件处判（用户引用口径裁定）：
   * - `group-resource` 的原件归属就是群，仍然只能引用本群资料；
   * - `attachment` / `artifact` 的原件是本人级的，允许跨群引用——这是有意的放宽，不是遗漏；
   * - 不属本人、不存在、已撤回三种不可见共用同一个 `teloa/forbidden`，不作存在性探测。
   */
  private async assertReferences(client:PoolClient,owner:string,groupId:string,references:readonly MessageReference[]):Promise<void>{
    for(const reference of references){
      if(reference.kind==='group-resource'){
        const found=await client.query('select resource_id from teloa_group_resource_versions versions join teloa_group_resources resources on resources.id=versions.resource_id and resources.owner_id=versions.owner_id and resources.group_id=versions.group_id where versions.resource_id=$1 and versions.owner_id=$2 and versions.group_id=$3 and versions.version=$4 and resources.withdrawn_at is null for share of versions,resources',[reference.id,owner,groupId,reference.version])
        if(!found.rows[0])throw new WorkError('teloa/forbidden',referenceInvisible)
      }else if(reference.kind==='attachment'){
        if(!await readActiveAttachment(client,owner,reference.id))throw new WorkError('teloa/forbidden',referenceInvisible)
      }else{
        // 契约只保证 36 位十六进制与连字符，未必是合法 uuid；先判形状再查，避免把格式问题变成数据库异常。
        const found=uuid(reference.id)?(await client.query('select 1 from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3 for share',[owner,reference.id,reference.version])).rows[0]:undefined
        if(!found)throw new WorkError('teloa/forbidden',referenceInvisible)
      }
    }
  }

  /** 每个提及都必须是本群的在岗AI 员工成员且岗位版本匹配；成员关系、在岗状态或岗位类型不符都判 teloa/forbidden，版本不符 teloa/version-conflict。 */
  private async assertMentions(client:PoolClient,owner:string,groupId:string,mentions:readonly GroupMention[]):Promise<void>{
    for(const mention of mentions){
      const found=await client.query('select roles.* from teloa_group_members members join teloa_roles roles on roles.id=members.role_id and roles.owner_id=members.owner_id where members.group_id=$1 and members.owner_id=$2 and members.role_id=$3 for share of members,roles',[groupId,owner,mention.roleId])
      const roleRow=found.rows[0]
      if(!roleRow)throw new WorkError('teloa/forbidden','该员工不在本群，无法提及。')
      const role=readStoredRole(roleRow)
      if(role.kind!=='employee'||role.state!=='active')throw new WorkError('teloa/forbidden','该员工不在本群，无法提及。')
      if(role.version!==mention.expectedVersion)throw new WorkError('teloa/version-conflict','被提及的员工已变化，请刷新后重发。')
    }
  }
}

/**
 * 岗位版本 +1 之后，按新岗位版本续签这位员工在各群的授权。**与 `renewMemberGrants` 互为另一半**：
 * 那条管群版本变化，这条管岗位版本变化。`group-agent-grants.ts` 的 `status()` 拿
 * `grant.roleVersion!==context.roleVersion` 判 `invalidated`，候选 SQL 的 `grants.role_version=roles.version`
 * （`group-routing-dispatch.ts`）据此把他从**每一个群**的候选集里删掉——不续签的话，改一次使命、
 * 或只是暂停再恢复，就让这位员工在所有群里的「直接回应」静默停摆。
 *
 * 判据与 `renewMemberGrants` 同：只对最新一版是 `active` 的续一行，`resources`/`canPost`/`canAutoRun`
 * 逐字沿用；`revoked` 不复活；已归档群不签；范围不支持不签；分身不签。**只有岗位状态这一项不同**：
 * 改岗位定义必须先暂停（`roles.ts` 的 `if(role.state!=='paused')throw`），把 `state==='active'`
 * 逐字照抄过来就永远续不出任何一行。这里取「未退役」，放宽不会让暂停的员工被选中——
 * `status()` 另有 `roleState!=='active'`、候选 SQL 另有 `roles.state='active'`，两道都还在。
 *
 * 事务由调用方提供：岗位那一笔与续签同生共死。**群行只读、不加锁**：群编辑的锁序是群 → 岗位，
 * 这里是岗位（调用方已 `for update`）→ 群，两边相反，加锁就会在「同时改同一位员工的岗位与他所在的群」
 * 时互等成 40P01（那个错误码不在仓内错误码联合里，冒出去只会变成一句看不懂的失败）。
 * 代价是群版本/归档状态可能在读到插入之间被改掉：那种情形下群编辑自己的 `renewMemberGrants`
 * 会先把 `grant_version+1` 那一行落下，我们这一笔撞唯一键、按「已被并发续签」跳过该群——
 * 宁可靠唯一键兜底，也不引入死锁。`on conflict do nothing` **不带冲突目标**：
 * 主键 `(group_id,role_id,grant_version)` 与 `unique(owner_id,request_id)` 两条都当作「已经有人续过了」，
 * 一条也不抛（在事务里 catch 23505 救不回来——语句一失败整笔事务就已经 aborted）。
 */
export async function renewRoleGrants(client:PoolClient,owner:string,role:DigitalRole,now:string):Promise<void>{
  if(role.kind!=='employee'||role.state==='retired')return
  // 成员表里有一行 member_key='self' 且 role_id 为 null；按 role_id 取的查询天然排除它。
  const memberships=(await client.query('select group_id from teloa_group_members where owner_id=$1 and role_id=$2 order by group_id',[owner,role.id])).rows
  for(const membership of memberships){
    const row=(await client.query('select * from teloa_groups where id=$1 and owner_id=$2',[membership.group_id,owner])).rows[0]
    if(!row||row.archived!==false)continue
    const group=readGroup(row)
    if(!roleSupportsScope(role.scopes,group.scope))continue
    const previous=(await client.query('select * from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version desc limit 1 for update',[group.id,role.id])).rows[0]
    if(!previous)continue
    const grant=readGroupAgentGrant(previous)
    if(grant.state!=='active'||grant.roleVersion===role.version)continue
    const resources=JSON.stringify(grant.resources)
    const spec=JSON.stringify({groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:grant.resources,canPost:grant.canPost,canAutoRun:grant.canAutoRun})
    // 不带目标的 on conflict 能「吞掉即安全」靠一条不变量：本表每个写入点都先取 teloa_roles 行锁（本函数的调用方持排他锁），
    // 主键冲突因此只可能来自已完成的同一续签；新增写入点或第三条 unique 时必须复核这句。
    await client.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
      values($1,$2,$3,$4,$5,$6,'active',$7::jsonb,$8,$9,$10,$11,$12) on conflict do nothing`,[group.id,owner,role.id,grant.grantVersion+1,group.version,role.version,resources,grant.canPost,grant.canAutoRun,roleRenewedGrantRequestId(owner,group.id,role.id,role.version),spec,now])
  }
}
