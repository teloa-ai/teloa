import type {Pool} from 'pg'
import {WorkError,isMessageReference,isResourceUsagePage,type ResourceUsageRelated} from '@teloa/contract'
/** 当前已关联的工作与员工，严格按本人及可见业务范围查询，不推断“实际读过”。 */
export async function readResourceRelations(pool:Pool,owner:string,resourceId:string,scopes:readonly string[]){
 const tables=(await pool.query("select to_regclass('teloa_task_materials') materials,to_regclass('teloa_projects') projects,to_regclass('teloa_roles') roles,to_regclass('teloa_groups') groups,to_regclass('teloa_group_messages') messages")).rows[0]
 const queries:string[]=[]
 if(tables.materials)queries.push("select distinct 'task' kind,t.id,t.definition->>'title' title,t.definition->>'scope' scope from teloa_task_materials m join teloa_tasks t on t.id=m.task_id and t.owner_id=m.owner_id where m.owner_id=$1 and m.resource_id=($2::text)::uuid and t.definition->>'scope'=any($3)")
 if(tables.projects)queries.push("select 'project' kind,id,definition->>'title' title,definition->>'scope' scope from teloa_projects where owner_id=$1 and definition->>'scope'=any($3) and definition->'links' @> jsonb_build_array(jsonb_build_object('kind','resource','id',$2::text))")
 if(tables.roles)queries.push("select 'employee' kind,id,definition->>'name' title,null::text scope from teloa_roles where owner_id=$1 and state<>'retired' and definition->>'kind'='employee' and definition->'scopes' ?| $3 and definition->'knowledge' ? $2")
 const rows=queries.length?(await pool.query(queries.map(query=>'('+query+')').join(' union all ')+' order by kind,id limit 21',[owner,resourceId,scopes])).rows:[]
 const related=rows.map(row=>({kind:row.kind,id:row.id,title:row.title,...(row.scope?{scope:row.scope}:{})})) as ResourceUsageRelated[]
 // 群项来自已经保存的消息引用；不从标题、UUID碰撞、员工知识或关联任务猜测实际引用。
 if(tables.groups&&tables.messages){
  const messages=(await pool.query(`select g.id,g.definition->>'name' title,g.definition->>'scope' scope,ref->>'version' resource_version,
   count(distinct m.id)::text citation_count,(array_agg(m.id order by m.created_at desc,m.id desc))[1] message_id,
   (array_agg(m.root_id order by m.created_at desc,m.id desc))[1] root_id,
   bool_and(jsonb_typeof(ref->'version')='number' and ref-'kind'-'id'-'version'='{}'::jsonb) reference_valid
   from teloa_group_messages m join teloa_groups g on g.id=m.group_id and g.owner_id=m.owner_id
   cross join lateral jsonb_array_elements(m.reference_snapshot) ref
   where m.owner_id=$1 and g.owner_id=$1 and g.definition->>'scope'=any($3)
    and ref->>'kind'='work-resource' and lower(ref->>'id')=lower($2)
   group by g.id,g.definition,ref->>'version' order by g.id,ref->>'version' limit 21`,[owner,resourceId,scopes])).rows
  for(const row of messages){
   const version=Number(row.resource_version),count=Number(row.citation_count)
   const item:ResourceUsageRelated={kind:'group',id:row.id,title:row.title,scope:row.scope,messageId:row.message_id,rootId:row.root_id,version,count}
   if(row.reference_valid!==true||!isMessageReference({kind:'work-resource',id:resourceId,version})||!isResourceUsagePage({resourceId,version:1,items:[],scanned:0,unavailable:0,nextCursor:null,related:[item],relatedMore:false}))throw new WorkError('teloa/storage-corrupt','群资料引用记录的固定身份或计数损坏。')
   related.push(item)
  }
 }
 related.sort((a,b)=>a.kind.localeCompare(b.kind,'en')||a.id.localeCompare(b.id,'en')||(a.kind==='group'&&b.kind==='group'?a.version-b.version:0))
 return {items:related.slice(0,20),more:related.length>20}
}
