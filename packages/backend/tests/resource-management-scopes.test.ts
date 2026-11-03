import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Client,Pool} from 'pg'
import {resourceScopes} from '@teloa/contract'
import {authorizeResourceActor,ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'
import {AuthorizedLocalMaterialCatalog} from '../src/capabilities/authorized-local-material-catalog.ts'

const scopes=Array.from({length:27},(_,i)=>'business_'+i)
const actor:ResourceActor={ownerId:'local:resource-manager',kind:'human',scopeIds:['general',...scopes]}

test('本人完整管理集合不套用资源/模型16范围合同；逐项格式、唯一性与owner仍严格',()=>{
 authorizeResourceActor(actor,actor.ownerId,[scopes.at(-1)!],true)
 authorizeResourceActor({...actor,scopeIds:['general',...Array.from({length:500},(_,i)=>'scope_'+i)]})
 assert.equal(resourceScopes(actor.scopeIds),false,'资源对象与模型授权的原合同不变')
 assert.equal(resourceScopes(scopes.slice(0,16)),true)
 for(const invalid of [[],['general','general'],['bad/scope'],[''],[null]])assert.throws(()=>authorizeResourceActor({...actor,scopeIds:invalid as string[]}),{code:'teloa/forbidden'})
 assert.throws(()=>authorizeResourceActor({...actor,kind:'agent'}),{code:'teloa/forbidden'})
 authorizeResourceActor({...actor,kind:'agent',scopeIds:scopes.slice(0,16)})
 assert.throws(()=>authorizeResourceActor(actor,'foreign-owner',[scopes[0]!]),{code:'teloa/forbidden'})
 assert.throws(()=>authorizeResourceActor(actor,actor.ownerId,['foreign-scope']),{code:'teloa/forbidden'})
})

test('真实目录与资料服务保留27业务末项的登记、完整列表、固定版读取和文件边界，foreign owner不能读取',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-resource-manager-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'first.md'),'# 合成首业务\n')
 await writeFile(join(root,'last.md'),'# 合成末业务\n')
 const pool=new Pool(),client=Object.assign(new Client(),{release(){}}),materials:Array<Record<string,unknown>>=[],requests:Array<Record<string,unknown>>=[]
 const resources:Array<Record<string,unknown>>=[],now=new Date('2026-01-01T00:00:00Z')
 t.after(()=>pool.end())
 // 仅替代SQL传输；真实服务、原件FD读取与原许可链均参与，不启动PG。
 const query=async(sql:unknown,values?:unknown[])=>{
  const s=String(sql),v=values??[];let rows:unknown[]=[]
  if(['begin','commit','rollback'].includes(s)||s.startsWith('select pg_advisory_xact_lock')){}
  else if(["select to_regclass('teloa_employee_knowledge_source_retirements') as present","select to_regclass('teloa_roles') as present"].includes(s))rows=[{present:null}]
  else if(s==='select * from teloa_authorized_local_material_requests where owner_id=$1 and request_id=$2')rows=requests.filter(r=>r.owner_id===v[0]&&r.request_id===v[1])
  else if(s==='select * from teloa_authorized_local_materials where owner_id=$1 and workspace_key=$2 and relative_path=$3')rows=materials.filter(r=>r.owner_id===v[0]&&r.workspace_key===v[1]&&r.relative_path===v[2])
  else if(s.startsWith('insert into teloa_authorized_local_materials('))materials.push({id:v[0],owner_id:v[1],title:v[2],relative_path:v[3],scope_ids:JSON.parse(String(v[4])),workspace_root:v[5],workspace_key:v[6],created_at:v[7]})
  else if(s.startsWith('insert into teloa_authorized_local_material_requests('))requests.push({owner_id:v[0],request_id:v[1],material_id:v[2],request_spec:JSON.parse(String(v[3])),result:JSON.parse(String(v[4]))})
  else if(s==='select * from teloa_authorized_local_materials where owner_id=$1 and id=$2')rows=materials.filter(r=>r.owner_id===v[0]&&r.id===v[1])
  else if(s==='select * from teloa_authorized_local_materials where owner_id=$1 and workspace_key=$2 order by created_at,id')rows=materials.filter(r=>r.owner_id===v[0]&&r.workspace_key===v[1])
  else if(s==='select * from teloa_authorized_local_materials where owner_id=$1 and workspace_root=$2 order by id')rows=materials.filter(r=>r.owner_id===v[0]&&r.workspace_root===v[1])
  else if(s==='select * from teloa_resource_drafts where owner_id=$1 order by created_at desc,id'){}
  else if(s.startsWith('select r.* from teloa_resources r where r.owner_id=$1 and not exists(')&&s.includes('teloa_employee_knowledge_source_retirements')&&s.endsWith('order by r.created_at desc,r.id'))rows=resources.filter(r=>r.owner_id===v[0])
  else if(s==='select * from teloa_resources where id=$1 for share')rows=resources.filter(r=>r.id===v[0])
  else throw Error('未声明的SQL传输：'+s)
  return {rows,command:'SELECT',rowCount:rows.length,oid:0,fields:[]}
 }
 t.mock.method(pool,'connect',async()=>client);t.mock.method(pool,'query',query);t.mock.method(client,'query',query)
 let approvals=0,active=true
 const catalog=new AuthorizedLocalMaterialCatalog(pool,{id:randomUUID,now:()=>now.toISOString()},{authorize:async(principal,target)=>{
  approvals++;assert.equal(principal.ownerId,actor.ownerId);assert(target.every(scope=>principal.scopeIds.includes(scope)))
  return {workspaceRoot:root,isProtectedPath:()=>false,assertCurrent(){assert(active)}}
 }})
 const firstCommand={requestId:randomUUID(),title:'首业务',path:'first.md',scopeIds:[scopes[0]!]}
 const lastCommand={requestId:randomUUID(),title:'第27业务',path:'last.md',scopeIds:[scopes.at(-1)!]}
 const first=await catalog.register(actor,firstCommand),last=await catalog.register(actor,lastCommand)
 assert.deepEqual(await catalog.register(actor,lastCommand),last,'原正常request幂等不变')
 assert.equal(materials.length,2);assert.equal(requests.length,2);assert(approvals>0)
 const context={actor},directory=await catalog.list(context)
 assert.deepEqual(directory.references,[first,last],'不能只取前16个业务，末业务原件仍可见')
 assert.equal((await catalog.read(last.id,last.version,context)).text,'# 合成末业务\n')
 assert.deepEqual(await catalog.current(last.id,context),last)
 assert.deepEqual(await catalog.fileBoundaries(actor),[{path:join(root,'first.md'),scopeIds:firstCommand.scopeIds},{path:join(root,'last.md'),scopeIds:lastCommand.scopeIds}])
 for(const [info,scope]of [[first,scopes[0]!],[last,scopes.at(-1)!]]as const)resources.push({id:randomUUID(),owner_id:actor.ownerId,revision:1,status:'active',spec:{title:info.title,sourceId:info.id,sourceVersion:info.version,scopeIds:[scope]},created_at:now,updated_at:now})
 const foreignId=randomUUID();resources.push({id:foreignId,owner_id:'foreign-owner',revision:1,status:'active',spec:{title:'其他本人',sourceId:first.id,sourceVersion:first.version,scopeIds:[scopes[0]!]},created_at:now,updated_at:now})
 const service=new ResourceService(pool,catalog,{id:randomUUID,now:()=>now.toISOString()})
 assert.deepEqual((await service.sourceDirectory(actor)).map(r=>r.id),[first.id,last.id])
 assert.equal((await service.list(actor)).resources.length,2,'仅本人两项资料，保留末业务')
 assert.equal((await service.list({...actor,scopeIds:[scopes[0]!]})).resources.length,1,'目标范围仍隔离')
 await assert.rejects(service.getResource(actor,{resourceId:foreignId}),{code:'teloa/forbidden'})
 await assert.rejects(catalog.read(last.id,last.version,{actor:{...actor,ownerId:'foreign-owner'}}),{code:'teloa/forbidden'})
 await assert.rejects(catalog.register({...actor,ownerId:'foreign-owner'},{...lastCommand,requestId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(catalog.read(last.id,last.version,{actor:{...actor,scopeIds:[scopes[0]!]}}),{code:'teloa/forbidden'})
 const before=approvals
 await assert.rejects(catalog.register(actor,{...lastCommand,requestId:randomUUID(),scopeIds:scopes.slice(0,17)}),{code:'teloa/invalid-input'})
 await assert.rejects(catalog.list({actor:{...actor,kind:'agent'}}),{code:'teloa/forbidden'})
 assert.equal(approvals,before,'模型17范围与资源17范围均在许可前拒绝')
 active=false;await assert.rejects(catalog.read(last.id,last.version,context),{code:'teloa/forbidden'})
})
