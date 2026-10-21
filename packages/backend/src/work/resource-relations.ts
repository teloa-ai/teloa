import type {Pool} from 'pg'
import type {ResourceUsageTarget} from '@teloa/contract'
/** 当前已关联的工作与员工，严格按本人及可见业务范围查询，不推断“实际读过”。 */
export async function readResourceRelations(pool:Pool,owner:string,resourceId:string,scopes:readonly string[]){
 const tables=(await pool.query("select to_regclass('teloa_task_materials') materials,to_regclass('teloa_projects') projects,to_regclass('teloa_roles') roles")).rows[0]
 const queries:string[]=[]
 if(tables.materials)queries.push("select distinct 'task' kind,t.id,t.definition->>'title' title,t.definition->>'scope' scope from teloa_task_materials m join teloa_tasks t on t.id=m.task_id and t.owner_id=m.owner_id where m.owner_id=$1 and m.resource_id=($2::text)::uuid and t.definition->>'scope'=any($3)")
 if(tables.projects)queries.push("select 'project' kind,id,definition->>'title' title,definition->>'scope' scope from teloa_projects where owner_id=$1 and definition->>'scope'=any($3) and definition->'links' @> jsonb_build_array(jsonb_build_object('kind','resource','id',$2::text))")
 if(tables.roles)queries.push("select 'employee' kind,id,definition->>'name' title,null::text scope from teloa_roles where owner_id=$1 and state<>'retired' and definition->>'kind'='employee' and definition->'scopes' ?| $3 and definition->'knowledge' ? $2")
 if(!queries.length)return {items:[],more:false}
 const rows=(await pool.query(queries.map(query=>'('+query+')').join(' union all ')+' order by kind,id limit 21',[owner,resourceId,scopes])).rows
 return {items:rows.slice(0,20).map(row=>({kind:row.kind,id:row.id,title:row.title,...(row.scope?{scope:row.scope}:{})})) as Array<ResourceUsageTarget&{title:string}>,more:rows.length>20}
}
