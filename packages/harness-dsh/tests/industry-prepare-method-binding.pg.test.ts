import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,initializeRoles,initializeCollaboration,initializeGroupAgentGrants,RoleService} from '@teloa/backend'
import {createIndustryPrepareHandler,type IndustryPreparePorts} from '../src/industry-prepare.ts'
import {createRoleHandler} from '../src/roles.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

// 实际端口：一键准备的方法绑定经真实 createRoleHandler + RoleService（PG 事务、CAS、编辑回执）保存；其余宿主端口为形状一致的替身。
const owner='local:teloa-owner',loadId='77777777-7777-4777-8777-777777777777',R='55555555-5555-4555-8555-555555555555',S1='22222222-2222-4222-8222-222222222222',INST='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NATIVE='grok-0123456789abcdef01234567-skill-0001',BODY='3'.repeat(64),hex=(c:string)=>c.repeat(64)
const fields={name:'写作伙伴',kind:'employee',scopes:['general'],duty:'按原模板方法修改本人提供的文字。',dataScope:'仅本人提供的资料。',executionScope:'沿用当前会话与员工的真实授权。',skills:[] as string[],knowledge:[] as string[],responsibility:testRoleResponsibility}
let container:StartedPostgreSqlContainer,pool:RoleService['pool'],temporary:string
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').withDatabase('teloa').start()
 temporary=await mkdtemp(join(tmpdir(),'teloa-method-binding-'));const config=join(temporary,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,identity)).pool
 // 原员工编辑会核对群成员与群授权，按真实库结构一并初始化
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop();if(temporary)await rm(temporary,{recursive:true,force:true})})

/** 加载、行业员工投影、安装与观测按原宿主回包形状提供；员工的建立与编辑全部落在真实 RoleService。 */
function host(options:{userEdits?:boolean}={}){
 const service=new RoleService(pool,identity),roleHandler=createRoleHandler(owner,async()=>service)
 const edits:unknown[]=[],resumes:unknown[]=[]
 let roleId:string|undefined
 const load={id:loadId,status:'active',templateTitle:'writing-bot',templateVersion:'1.0.0',mappingHash:hex('a'),relations:[{kind:'role-skill',from:R,to:S1}],
  items:[{instanceId:R,kind:'role',title:'写作伙伴',required:true,status:'pending-adapter'},{instanceId:S1,kind:'skill',title:'Writing revision',required:true,status:'pending-adapter'}]}
 const installation={id:INST,ownerId:owner,source:{kind:'industry-local',loadId,itemInstanceId:S1,contentId:'c0000000-0000-4000-8000-000000000000',contentHash:hex('e'),resourceId:'skill-0001',resourceVersion:'1.0.0'},bundleHash:hex('d'),native:{name:NATIVE,description:'Writing revision',modelInvocable:true,userInvocable:true,bodyHash:BODY},state:'installed',version:1,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z'}
 const ports:IndustryPreparePorts={
  loads:async()=>load,knowledge:async()=>({items:[]}),mcp:async()=>({items:[]}),dataSources:async()=>({items:[]}),executionTools:async()=>({items:[]}),plugins:async()=>({items:[]}),
  roles:async(endpoint)=>{
   if(endpoint==='industry-roles/instantiate'){
    // 与 industry-roles.ts:150 相同：以暂停态经原 RoleService 建员工
    roleId=(await service.create(owner,{requestId:randomUUID(),fields},{state:'paused'})).id
    if(options.userEdits){const created=(await service.list(owner,{})).find(row=>row.id===roleId)!;await roleHandler('roles/edit',{roleId,expectedVersion:created.version,fields:{...fields,duty:'本人改过的职责。'}})}
    return {}
   }
   const role=roleId?(await service.list(owner,{})).find(row=>row.id===roleId):undefined
   return {items:role?[{loadId,itemInstanceId:R,state:'paused',revision:2,role:{id:role.id,version:role.version,state:role.state}}]:[]}
  },
  roleRecords:async(endpoint,payload)=>{if(endpoint==='roles/edit')edits.push(structuredClone(payload));return roleHandler(endpoint,payload)},
  // 预览按原形状返回该加载条目的固定自装来源与正文（只读，不安装）
  skills:async(endpoint)=>endpoint==='skill-installations/list'?{items:[installation],usages:[{loadId,itemInstanceId:S1,installationId:INST}]}:endpoint==='skill-installations/preview'?{source:installation.source,bundleHash:installation.bundleHash,native:installation.native,files:[{path:'SKILL.md',hash:hex('1'),size:10}]}:{installationId:INST,scope:'default-workspace',state:'available',current:{name:NATIVE,description:'Writing revision',modelInvocable:true,userInvocable:true,bodyHash:BODY,provider:'teloa-market',source:'managed'}},
  lifecycle:async payload=>{resumes.push(structuredClone(payload));return {}},
  sleep:async()=>{},
 }
 return {service,roleHandler,edits,resumes,roleId:()=>roleId!,handler:createIndustryPrepareHandler(owner,async()=>ports)}
}

test('实际端口：一键准备经真实 roles/edit 把已装方法写回首建员工（v1→v2），重放命中编辑回执、不同修改冲突',async()=>{
 const h=host(),r:any=await h.handler('industry-loads/readiness',{loadId})
 await h.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 const role=(await h.service.list(owner,{})).find(row=>row.id===h.roleId())!
 assert.deepEqual([role.version,role.state,role.skills],[2,'paused',[NATIVE]])
 assert.deepEqual({name:role.name,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,scopes:role.scopes,knowledge:role.knowledge,responsibility:role.responsibility},{name:fields.name,duty:fields.duty,dataScope:fields.dataScope,executionScope:fields.executionScope,scopes:fields.scopes,knowledge:fields.knowledge,responsibility:fields.responsibility})
 assert.deepEqual(h.resumes,[{roleId:h.roleId(),expectedVersion:2,action:'resume',reason:'方案一键准备'}])
 const receipt=(await pool.query('select base_version from teloa_role_edits where role_id=$1',[h.roleId()])).rows
 assert.deepEqual(receipt,[{base_version:1}])
 // 同一请求重放：原编辑回执返回同一结果，不再写版本
 const replay:any=await h.roleHandler('roles/edit',h.edits[0])
 assert.deepEqual([replay.version,replay.skills],[2,[NATIVE]])
 assert.equal((await h.service.list(owner,{})).find(row=>row.id===h.roleId())!.version,2)
 await assert.rejects(h.roleHandler('roles/edit',{...(h.edits[0] as object),fields:{...fields,skills:['other-skill']}}),/原版本已保存不同修改/)
})

test('实际端口：本人在创建后已改过的员工不被方法绑定覆盖、不上岗',async()=>{
 const h=host({userEdits:true}),r:any=await h.handler('industry-loads/readiness',{loadId})
 const receipt:any=await h.handler('industry-loads/prepare',{loadId,expectedDigest:r.digest})
 assert.match(receipt.results.find((x:any)=>x.step==='role-resume').message,/已被修改/)
 const role=(await h.service.list(owner,{})).find(row=>row.id===h.roleId())!
 assert.deepEqual([role.version,role.duty,role.skills],[2,'本人改过的职责。',[]])
 assert.deepEqual([h.edits.length,h.resumes.length],[0,0])
})
