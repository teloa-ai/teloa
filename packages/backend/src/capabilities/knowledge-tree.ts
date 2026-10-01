import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isKnowledgeNode,isKnowledgeSpace,isKnowledgeTree,isKnowledgeTreeMutation,resourceId,resourceVersion,type KnowledgeNode,type KnowledgeSpace,type KnowledgeTree,type KnowledgeTreeMutation} from '@teloa/contract'
import {authorizeResourceActor,type ResourceActor} from './resources.ts'

const bad=()=>new WorkError('teloa/invalid-input','知识目录请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','知识目录记录损坏，已停止读取。')
const unavailable=()=>new WorkError('teloa/storage-unavailable','知识目录当前不可用。')
const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw bad();return value as Record<string,unknown>}
const title=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||value.length>200)throw bad();return value.trim()}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const identityHash=(ownerId:string,workspaceId:string)=>createHash('md5').update(ownerId+'\x1f'+workspaceId).digest('hex')
const ids=(ownerId:string,workspaceId:string)=>{const hash=identityHash(ownerId,workspaceId);return {spaceId:'space_'+hash,rootNodeId:'root_'+hash}}
const pageNodeId=(knowledgeId:string)=>'page_'+knowledgeId.toLowerCase()

function spaceRow(row:Record<string,unknown>):KnowledgeSpace{
 const value={id:row.id,ownerId:row.owner_id,workspaceId:row.workspace_id,title:row.title,rootNodeId:row.root_node_id,directoryRevision:row.directory_revision,scopeIds:row.scope_ids,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
 if(!isKnowledgeSpace(value))throw corrupt()
 return value
}
function nodeRow(row:Record<string,unknown>):KnowledgeNode{
 const common={id:row.id,spaceId:row.space_id,parentId:row.parent_id,type:row.node_type,title:row.title,siblingOrder:row.sibling_order,path:row.path,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
 const value=row.node_type==='page'?{...common,knowledgeId:row.knowledge_id}:common
 if(!isKnowledgeNode(value))throw corrupt()
 return value
}
function same(value:unknown,expected:unknown):boolean{
 try{return isDeepStrictEqual(value,expected)}catch{throw corrupt()}
}

export async function initializeKnowledgeTree(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_knowledge_spaces(
   owner_id text not null,id text not null check(id ~ '^[a-zA-Z0-9_-]{1,128}$'),workspace_id text not null check(workspace_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
   title text not null check(length(title) between 1 and 200),root_node_id text not null check(root_node_id ~ '^[a-zA-Z0-9_-]{1,128}$'),directory_revision integer not null check(directory_revision>0),
   scope_ids jsonb not null check(jsonb_typeof(scope_ids)='array'),created_at timestamptz not null,updated_at timestamptz not null,
   primary key(owner_id,id),unique(owner_id,workspace_id)
  );
  create table if not exists teloa_knowledge_nodes(
   owner_id text not null,id text not null check(id ~ '^[a-zA-Z0-9_-]{1,128}$'),space_id text not null,parent_id text,node_type text not null check(node_type in ('space','folder','page')),
   title text not null check(length(title) between 1 and 200),sibling_order integer not null check(sibling_order>=0),path jsonb not null check(jsonb_typeof(path)='array'),knowledge_id uuid,
   created_at timestamptz not null,updated_at timestamptz not null,primary key(owner_id,id),unique(owner_id,knowledge_id),
   foreign key(owner_id,space_id) references teloa_knowledge_spaces(owner_id,id) deferrable initially deferred,
   foreign key(owner_id,parent_id) references teloa_knowledge_nodes(owner_id,id) deferrable initially deferred,
   foreign key(owner_id,knowledge_id) references teloa_knowledge_items(owner_id,id) deferrable initially deferred,
   check((node_type='space' and parent_id is null and knowledge_id is null and sibling_order=0) or (node_type='folder' and parent_id is not null and knowledge_id is null) or (node_type='page' and parent_id is not null and knowledge_id is not null))
  );
  create table if not exists teloa_knowledge_directory_operations(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),operation text not null check(operation in ('create-folder','move','rename')),
   result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,primary key(owner_id,request_id)
  );
  insert into teloa_knowledge_spaces(owner_id,id,workspace_id,title,root_node_id,directory_revision,scope_ids,created_at,updated_at)
  select owner_id,'space_'||md5(owner_id||chr(31)||workspace_id),workspace_id,'知识库','root_'||md5(owner_id||chr(31)||workspace_id),1,'["general"]'::jsonb,min(created_at),max(updated_at)
  from teloa_knowledge_items group by owner_id,workspace_id on conflict(owner_id,workspace_id) do nothing;
  insert into teloa_knowledge_nodes(owner_id,id,space_id,parent_id,node_type,title,sibling_order,path,knowledge_id,created_at,updated_at)
  select owner_id,root_node_id,id,null,'space',title,0,jsonb_build_array(root_node_id),null,created_at,updated_at from teloa_knowledge_spaces
  on conflict(owner_id,id) do nothing;
  with missing as(
   select i.*,s.id as space_id,s.root_node_id,coalesce((select max(n.sibling_order)+1 from teloa_knowledge_nodes n where n.owner_id=i.owner_id and n.space_id=s.id and n.parent_id=s.root_node_id),0) as base
   from teloa_knowledge_items i join teloa_knowledge_spaces s on s.owner_id=i.owner_id and s.workspace_id=i.workspace_id
   where not exists(select 1 from teloa_knowledge_nodes n where n.owner_id=i.owner_id and n.knowledge_id=i.id)
  ),ranked as(
   select missing.*,row_number() over(partition by owner_id,workspace_id order by created_at,id)-1 as ordinal from missing
  )
  insert into teloa_knowledge_nodes(owner_id,id,space_id,parent_id,node_type,title,sibling_order,path,knowledge_id,created_at,updated_at)
  select owner_id,'page_'||id::text,space_id,root_node_id,'page',title,base+ordinal,jsonb_build_array(root_node_id,'page_'||id::text),id,created_at,updated_at from ranked
  on conflict(owner_id,knowledge_id) do nothing;
  update teloa_knowledge_spaces s set directory_revision=greatest(s.directory_revision,1+(select count(*) from teloa_knowledge_nodes n where n.owner_id=s.owner_id and n.space_id=s.id and n.node_type<>'space'));
  do $$ begin
   if not exists(select 1 from pg_constraint where conrelid='teloa_knowledge_spaces'::regclass and conname='teloa_knowledge_spaces_root_fk') then
    alter table teloa_knowledge_spaces add constraint teloa_knowledge_spaces_root_fk foreign key(owner_id,root_node_id) references teloa_knowledge_nodes(owner_id,id) deferrable initially deferred;
   end if;
  end $$;
  create or replace function teloa_reject_knowledge_directory_operation_mutation() returns trigger language plpgsql as $$
  begin raise exception 'knowledge directory operations are immutable'; end $$;
  drop trigger if exists teloa_knowledge_directory_operations_immutable on teloa_knowledge_directory_operations;
  create trigger teloa_knowledge_directory_operations_immutable before update or delete on teloa_knowledge_directory_operations
  for each row execute function teloa_reject_knowledge_directory_operation_mutation();
 `)
}

async function lockSpace(client:PoolClient,ownerId:string,workspaceId:string,now:string):Promise<KnowledgeSpace>{
 await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['knowledge-space',ownerId,workspaceId])])
 let row=(await client.query('select * from teloa_knowledge_spaces where owner_id=$1 and workspace_id=$2 for update',[ownerId,workspaceId])).rows[0] as Record<string,unknown>|undefined
 if(!row){
  const {spaceId,rootNodeId}=ids(ownerId,workspaceId)
  await client.query("insert into teloa_knowledge_spaces(owner_id,id,workspace_id,title,root_node_id,directory_revision,scope_ids,created_at,updated_at) values($1,$2,$3,'知识库',$4,1,'[\"general\"]',$5,$5)",[ownerId,spaceId,workspaceId,rootNodeId,now])
  await client.query("insert into teloa_knowledge_nodes(owner_id,id,space_id,parent_id,node_type,title,sibling_order,path,knowledge_id,created_at,updated_at) values($1,$2,$3,null,'space','知识库',0,$4,null,$5,$5)",[ownerId,rootNodeId,spaceId,JSON.stringify([rootNodeId]),now])
  row=(await client.query('select * from teloa_knowledge_spaces where owner_id=$1 and workspace_id=$2 for update',[ownerId,workspaceId])).rows[0]
 }
 return spaceRow(row!)
}
async function readNode(client:PoolClient,ownerId:string,nodeId:string,lock=false):Promise<KnowledgeNode>{
 const row=(await client.query('select * from teloa_knowledge_nodes where owner_id=$1 and id=$2'+(lock?' for update':''),[ownerId,nodeId])).rows[0]
 if(!row)throw new WorkError('teloa/not-found','知识目录节点不存在。')
 return nodeRow(row)
}
async function updateSpace(client:PoolClient,space:KnowledgeSpace,now:string):Promise<KnowledgeSpace>{
 const row=(await client.query('update teloa_knowledge_spaces set directory_revision=directory_revision+1,updated_at=$3 where owner_id=$1 and id=$2 returning *',[space.ownerId,space.id,now])).rows[0]
 return spaceRow(row)
}
async function orderedChildren(client:PoolClient,ownerId:string,spaceId:string,parentId:string,exclude?:string):Promise<KnowledgeNode[]>{
 const values=(await client.query('select * from teloa_knowledge_nodes where owner_id=$1 and space_id=$2 and parent_id=$3 order by sibling_order,id',[ownerId,spaceId,parentId])).rows.map(nodeRow)
 return exclude?values.filter(value=>value.id!==exclude):values
}
async function storedTree(client:PoolClient,space:KnowledgeSpace):Promise<KnowledgeTree>{
 const rows=(await client.query('select * from teloa_knowledge_nodes where owner_id=$1 and space_id=$2',[space.ownerId,space.id])).rows.map(nodeRow),byParent=new Map<string,KnowledgeNode[]>()
 for(const node of rows){if(node.parentId!==null){const children=byParent.get(node.parentId)??[];children.push(node);byParent.set(node.parentId,children)}}
 for(const children of byParent.values())children.sort((left,right)=>left.siblingOrder-right.siblingOrder||left.id.localeCompare(right.id))
 const ordered:KnowledgeNode[]=[],root=rows.find(node=>node.id===space.rootNodeId)
 if(!root)throw corrupt()
 const visit=(node:KnowledgeNode)=>{ordered.push(node);for(const child of byParent.get(node.id)??[])visit(child)}
 visit(root)
 const tree={space,nodes:ordered}
 if(ordered.length!==rows.length||!isKnowledgeTree(tree))throw corrupt()
 return tree
}
async function reorder(client:PoolClient,ownerId:string,nodes:KnowledgeNode[],now:string):Promise<void>{
 for(let index=0;index<nodes.length;index++)await client.query('update teloa_knowledge_nodes set sibling_order=$3,updated_at=case when sibling_order=$3 then updated_at else $4 end where owner_id=$1 and id=$2',[ownerId,nodes[index]!.id,index,now])
}
const at=(value:unknown,count:number):number=>{if(value===undefined)return count;if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>count)throw bad();return Number(value)}

export async function attachKnowledgePage(client:PoolClient,input:{ownerId:string;workspaceId:string;knowledgeId:string;title:string;parentId?:string;expectedDirectoryRevision?:number;position?:number;now:string}):Promise<KnowledgeTreeMutation>{
 if(!stable(input.workspaceId)||!resourceId(input.knowledgeId)||!Number.isFinite(Date.parse(input.now)))throw corrupt()
 const space=await lockSpace(client,input.ownerId,input.workspaceId,input.now)
 await storedTree(client,space)
 if(input.expectedDirectoryRevision!==undefined&&space.directoryRevision!==input.expectedDirectoryRevision)throw new WorkError('teloa/version-conflict','知识目录已变化，请重新读取后操作。')
 const parent=await readNode(client,input.ownerId,input.parentId??space.rootNodeId,true)
 if(parent.spaceId!==space.id)throw new WorkError('teloa/forbidden','目标目录不属于当前知识空间。')
 if(parent.type==='page')throw new WorkError('teloa/conflict','Markdown 页面是叶子节点，不能包含子节点。')
 const id=pageNodeId(input.knowledgeId),existing=(await client.query('select * from teloa_knowledge_nodes where owner_id=$1 and knowledge_id=$2',[input.ownerId,input.knowledgeId])).rows[0]
 if(existing){const node=nodeRow(existing);if(node.id!==id||node.spaceId!==space.id)throw corrupt();return {space,node}}
 const siblings=await orderedChildren(client,input.ownerId,space.id,parent.id),position=at(input.position,siblings.length),now=input.now
 const path=[...parent.path,id]
 await client.query("insert into teloa_knowledge_nodes(owner_id,id,space_id,parent_id,node_type,title,sibling_order,path,knowledge_id,created_at,updated_at) values($1,$2,$3,$4,'page',$5,$6,$7,$8,$9,$9)",[input.ownerId,id,space.id,parent.id,title(input.title),position,JSON.stringify(path),input.knowledgeId,now])
 const node=nodeRow((await client.query('select * from teloa_knowledge_nodes where owner_id=$1 and id=$2',[input.ownerId,id])).rows[0])
 siblings.splice(position,0,node);await reorder(client,input.ownerId,siblings,now)
 return {space:await updateSpace(client,space,now),node:{...node,siblingOrder:position}}
}

export class KnowledgeTreeService{
 private readonly pool:Pool
 private readonly workspaceId:string
 private readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,workspaceId:string,identity:{id:()=>string;now:()=>string}){if(!stable(workspaceId))throw bad();this.pool=pool;this.workspaceId=workspaceId;this.identity=identity}
 private now():string{const value=this.identity.now();if(!Number.isFinite(Date.parse(value)))throw corrupt();return value}
 private async mutation(actor:ResourceActor,requestId:string,spec:Record<string,unknown>,operation:'create-folder'|'move'|'rename',change:(client:PoolClient,space:KnowledgeSpace,now:string)=>Promise<KnowledgeNode>):Promise<KnowledgeTreeMutation>{
  authorizeResourceActor(actor,actor.ownerId,[],true)
  const client=await this.pool.connect().catch(()=>{throw unavailable()})
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['knowledge-directory-request',actor.ownerId,requestId])])
   const prior=(await client.query('select * from teloa_knowledge_directory_operations where owner_id=$1 and request_id=$2',[actor.ownerId,requestId])).rows[0] as Record<string,unknown>|undefined
   if(prior){
    if(prior.operation!==operation||!same(prior.request_spec,spec))throw new WorkError('teloa/conflict','同一请求 ID 不能执行另一项知识目录修改。')
    if(!isKnowledgeTreeMutation(prior.result))throw corrupt()
    await client.query('commit');return prior.result
   }
   const now=this.now(),space=await lockSpace(client,actor.ownerId,this.workspaceId,now)
   await storedTree(client,space)
   const node=await change(client,space,now),updated=await updateSpace(client,space,now),result={space:updated,node}
   if(!isKnowledgeTreeMutation(result))throw corrupt()
   await client.query('insert into teloa_knowledge_directory_operations(owner_id,request_id,request_spec,operation,result,created_at) values($1,$2,$3,$4,$5,$6)',[actor.ownerId,requestId,JSON.stringify(spec),operation,JSON.stringify(result),now])
   await client.query('commit');return result
  }catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw unavailable()}finally{client.release()}
 }
 async list(actor:ResourceActor,input:unknown):Promise<KnowledgeTree>{
  authorizeResourceActor(actor);exact(input,[])
  const client=await this.pool.connect().catch(()=>{throw unavailable()})
  try{
   await client.query('begin')
   const space=await lockSpace(client,actor.ownerId,this.workspaceId,this.now()),tree=await storedTree(client,space)
   await client.query('commit');return tree
  }catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw unavailable()}finally{client.release()}
 }
 async createFolder(actor:ResourceActor,input:unknown):Promise<KnowledgeTreeMutation>{
  const row=exact(input,['requestId','parentId','title','expectedDirectoryRevision','position'])
  if(!resourceId(row.requestId)||!stable(row.parentId)||!resourceVersion(row.expectedDirectoryRevision)||(row.position!==undefined&&(!Number.isSafeInteger(row.position)||Number(row.position)<0)))throw bad()
  const spec={operation:'create-folder',parentId:row.parentId,title:title(row.title),expectedDirectoryRevision:row.expectedDirectoryRevision,position:row.position??null}
  return this.mutation(actor,(row.requestId as string).toLowerCase(),spec,'create-folder',async(client,space,now)=>{
   if(space.directoryRevision!==row.expectedDirectoryRevision)throw new WorkError('teloa/version-conflict','知识目录已变化，请重新读取后操作。')
   const parent=await readNode(client,actor.ownerId,row.parentId as string,true);if(parent.spaceId!==space.id)throw new WorkError('teloa/forbidden','目标目录不属于当前知识空间。');if(parent.type==='page')throw new WorkError('teloa/conflict','Markdown 页面是叶子节点，不能包含子节点。')
   const id=this.identity.id();if(!resourceId(id))throw corrupt()
   const siblings=await orderedChildren(client,actor.ownerId,space.id,parent.id),position=at(row.position,siblings.length),path=[...parent.path,id]
   await client.query("insert into teloa_knowledge_nodes(owner_id,id,space_id,parent_id,node_type,title,sibling_order,path,knowledge_id,created_at,updated_at) values($1,$2,$3,$4,'folder',$5,$6,$7,null,$8,$8)",[actor.ownerId,id,space.id,parent.id,spec.title,position,JSON.stringify(path),now])
   const node=nodeRow((await client.query('select * from teloa_knowledge_nodes where owner_id=$1 and id=$2',[actor.ownerId,id])).rows[0]);siblings.splice(position,0,node);await reorder(client,actor.ownerId,siblings,now);return {...node,siblingOrder:position}
  })
 }
 async renameNode(actor:ResourceActor,input:unknown):Promise<KnowledgeTreeMutation>{
  const row=exact(input,['requestId','nodeId','title','expectedDirectoryRevision'])
  if(!resourceId(row.requestId)||!stable(row.nodeId)||!resourceVersion(row.expectedDirectoryRevision))throw bad()
  const spec={operation:'rename',nodeId:row.nodeId,title:title(row.title),expectedDirectoryRevision:row.expectedDirectoryRevision}
  return this.mutation(actor,(row.requestId as string).toLowerCase(),spec,'rename',async(client,space,now)=>{
   if(space.directoryRevision!==row.expectedDirectoryRevision)throw new WorkError('teloa/version-conflict','知识目录已变化，请重新读取后操作。')
   const node=await readNode(client,actor.ownerId,row.nodeId as string,true);if(node.spaceId!==space.id||node.type==='space')throw new WorkError('teloa/conflict','知识空间根节点不能重命名或跨空间操作。')
   return nodeRow((await client.query('update teloa_knowledge_nodes set title=$3,updated_at=$4 where owner_id=$1 and id=$2 returning *',[actor.ownerId,node.id,spec.title,now])).rows[0])
  })
 }
 async moveNode(actor:ResourceActor,input:unknown):Promise<KnowledgeTreeMutation>{
  const row=exact(input,['requestId','nodeId','parentId','expectedDirectoryRevision','position'])
  if(!resourceId(row.requestId)||!stable(row.nodeId)||!stable(row.parentId)||!resourceVersion(row.expectedDirectoryRevision)||(row.position!==undefined&&(!Number.isSafeInteger(row.position)||Number(row.position)<0)))throw bad()
  const spec={operation:'move',nodeId:row.nodeId,parentId:row.parentId,expectedDirectoryRevision:row.expectedDirectoryRevision,position:row.position??null}
  return this.mutation(actor,(row.requestId as string).toLowerCase(),spec,'move',async(client,space,now)=>{
   if(space.directoryRevision!==row.expectedDirectoryRevision)throw new WorkError('teloa/version-conflict','知识目录已变化，请重新读取后操作。')
   const node=await readNode(client,actor.ownerId,row.nodeId as string,true),parent=await readNode(client,actor.ownerId,row.parentId as string,true)
   if(node.spaceId!==space.id||parent.spaceId!==space.id)throw new WorkError('teloa/forbidden','目录节点不属于当前知识空间。')
   if(node.type==='space'||parent.type==='page'||parent.path.includes(node.id))throw new WorkError('teloa/conflict',parent.type==='page'?'Markdown 页面是叶子节点，不能包含子节点。':'知识目录不能移动到自身或后代节点。')
   const oldParent=node.parentId!,oldSiblings=await orderedChildren(client,actor.ownerId,space.id,oldParent,node.id),targetSiblings=oldParent===parent.id?oldSiblings:await orderedChildren(client,actor.ownerId,space.id,parent.id,node.id),position=at(row.position,targetSiblings.length),oldPath=node.path,newPath=[...parent.path,node.id]
   const descendants=(await client.query('select * from teloa_knowledge_nodes where owner_id=$1 and space_id=$2',[actor.ownerId,space.id])).rows.map(nodeRow).filter(value=>value.path.length>=oldPath.length&&oldPath.every((part,index)=>value.path[index]===part))
   for(const descendant of descendants){const path=[...newPath,...descendant.path.slice(oldPath.length)];await client.query('update teloa_knowledge_nodes set path=$3,updated_at=$4 where owner_id=$1 and id=$2',[actor.ownerId,descendant.id,JSON.stringify(path),now])}
   const moved=nodeRow((await client.query('update teloa_knowledge_nodes set parent_id=$3,sibling_order=$4,updated_at=$5 where owner_id=$1 and id=$2 returning *',[actor.ownerId,node.id,parent.id,position,now])).rows[0])
   if(oldParent!==parent.id)await reorder(client,actor.ownerId,oldSiblings,now)
   targetSiblings.splice(position,0,moved);await reorder(client,actor.ownerId,targetSiblings,now)
   return {...moved,path:newPath,siblingOrder:position}
  })
 }
}
