import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../src/work/projects.ts'
import {initializeProjectContext,ProjectContextService,registerProjectMemoryAvailability} from '../src/work/project-context.ts'
import {initializeProjectPersonalMemory,ProjectPersonalMemoryService} from '../src/work/project-personal-memory.ts'
test('真实PG：本人显式个人偏好、版本幂等与撤回不泄露正文',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()});await initializeProjectPersonalMemory(pool)
 const owner=randomUUID(),service=new ProjectPersonalMemoryService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 assert.deepEqual(await service.get(owner),{version:0,entries:[]})
 const input={requestId:randomUUID(),expectedVersion:0,entryId:null,topic:'表达',markdown:'优先简洁中文'}
 const saved=await service.save(owner,input);assert.equal(saved.version,1);assert.equal(saved.entries[0]!.markdown,input.markdown)
 assert.deepEqual(saved.entries[0],{id:saved.entries[0]!.id,version:1,topic:'表达',markdown:'优先简洁中文'},'普通条目输出保持原样，不带 source 键')
 assert.deepEqual(await service.save(owner,input),saved)
 assert.deepEqual(await service.get('other'),{version:0,entries:[]})
 await assert.rejects(service.withdraw('other',{requestId:randomUUID(),expectedVersion:0,entryId:saved.entries[0]!.id}))
 const removed=await service.withdraw(owner,{requestId:randomUUID(),expectedVersion:1,entryId:saved.entries[0]!.id});assert.deepEqual(removed,{version:2,entries:[]})
 assert.deepEqual(await service.save(owner,input),removed,'幂等重试不重新显示已撤回正文')
 const text=JSON.stringify((await pool.query('select * from teloa_personal_memory_requests')).rows);assert.equal(text.includes('优先简洁中文'),false,'请求日志仅保存摘要和身份')
})
test('真实PG：显式采用项目经验为独立个人副本，核当前来源、拒归档并保持 CAS/幂等/撤回语义',{timeout:90000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectPersonalMemory(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},projects=new ProjectService(pool,identity),context=new ProjectContextService(pool,identity),personal=new ProjectPersonalMemoryService(pool,identity)
 const fields={scope:'general',title:'采用来源',goal:'验证显式采用',dueDate:null,state:'planning',links:[],references:[]}
 const project=await projects.create(owner,{requestId:randomUUID(),fields})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'平台',markdown:'只做Mac'}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:1,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'经验',markdown:'记忆独有内容'}})
 const entries=(await context.get(owner,{projectId:project.id})).entries,rule=entries.find(e=>e.kind==='rule')!,memory=entries.find(e=>e.kind==='memory')!
 const unavailable=new Set<string>()
 t.after(registerProjectMemoryAvailability(pool,owner,async(_db,_owner,{entryId})=>!unavailable.has(entryId)))
 const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
 // 有效采用：正文与主题取服务端固定版本，带结构化 source
 const first={requestId:randomUUID(),projectId:project.id,entryId:rule.id,entryVersion:1,expectedPersonalVersion:0}
 const adopted=await personal.publishProjectExperience(owner,first)
 assert.equal(adopted.version,1);assert.equal(adopted.entries.length,1)
 const copy=adopted.entries[0]!
 assert.deepEqual({...copy,id:'x'},{id:'x',version:1,topic:'平台',markdown:'只做Mac',source:{projectId:project.id,entryId:rule.id,entryVersion:1,basisHash:sha('只做Mac')}})
 // 相同请求回放；同 requestId 不同载荷拒绝
 assert.deepEqual(await personal.publishProjectExperience(owner,first),adopted)
 await assert.rejects(personal.publishProjectExperience(owner,{...first,entryVersion:2}),/已更新|重新读取/)
 // CAS、错误版本、重复采用同一版本、本人隔离
 await assert.rejects(personal.publishProjectExperience(owner,{...first,requestId:randomUUID()}),/已更新|重新读取/,'expectedPersonalVersion 过期')
 await assert.rejects(personal.publishProjectExperience(owner,{...first,requestId:randomUUID(),entryVersion:2,expectedPersonalVersion:1}),/来源|版本/,'来源版本不是当前版本')
 await assert.rejects(personal.publishProjectExperience(owner,{...first,requestId:randomUUID(),expectedPersonalVersion:1}),/已采用/,'同一来源版本不重复生成副本')
 await assert.rejects(personal.publishProjectExperience('other',{...first,requestId:randomUUID()}),'他人不能采用本人项目的条目')
 assert.deepEqual(await personal.get('other'),{version:0,entries:[]})
 // 来源依据失效时拒绝；恢复后可采用
 unavailable.add(memory.id)
 await assert.rejects(personal.publishProjectExperience(owner,{requestId:randomUUID(),projectId:project.id,entryId:memory.id,entryVersion:1,expectedPersonalVersion:1}),/依据|失效/)
 unavailable.delete(memory.id)
 const second=await personal.publishProjectExperience(owner,{requestId:randomUUID(),projectId:project.id,entryId:memory.id,entryVersion:1,expectedPersonalVersion:1})
 assert.equal(second.version,2);assert.equal(second.entries.length,2)
 const memoryCopy=second.entries.find(e=>e.source?.entryId===memory.id)!
 assert.deepEqual(memoryCopy.source,{projectId:project.id,entryId:memory.id,entryVersion:1,basisHash:sha('记忆独有内容')})
 // 项目侧改版再撤回：已采用副本独立保留；已撤回来源的新版本不能再采用
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:2,change:{kind:'save-entry',entryId:memory.id,entryKind:'memory',topic:'经验',markdown:'改版后的内容'}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:3,change:{kind:'withdraw-entry',entryId:memory.id}})
 const afterWithdraw=await personal.get(owner)
 assert.equal(afterWithdraw.version,2,'项目撤回不改写个人真源版本')
 assert.deepEqual(afterWithdraw.entries.find(e=>e.id===memoryCopy.id),memoryCopy,'原项目撤回不自动销毁本人已采用的副本')
 await assert.rejects(personal.publishProjectExperience(owner,{requestId:randomUUID(),projectId:project.id,entryId:memory.id,entryVersion:2,expectedPersonalVersion:2}),/来源|撤回|版本/)
 // 手工改正文后清来源，不冒称仍等于原来源
 const edited=await personal.save(owner,{requestId:randomUUID(),expectedVersion:2,entryId:copy.id,topic:'平台',markdown:'只做Mac，必要时兼顾Linux'})
 assert.equal(edited.version,3)
 assert.deepEqual(edited.entries.find(e=>e.id===copy.id),{id:copy.id,version:2,topic:'平台',markdown:'只做Mac，必要时兼顾Linux'},'手工编辑后输出不再带 source')
 // 归档项目拒绝采用
 const archivedProject=await projects.create(owner,{requestId:randomUUID(),fields:{...fields,title:'已归档来源'}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:archivedProject.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'归档规则',markdown:'归档正文'}})
 const archivedRule=(await context.get(owner,{projectId:archivedProject.id})).entries[0]!
 await projects.edit(owner,{projectId:archivedProject.id,expectedVersion:archivedProject.version,fields:{...fields,title:'已归档来源',state:'archived'}})
 await assert.rejects(personal.publishProjectExperience(owner,{requestId:randomUUID(),projectId:archivedProject.id,entryId:archivedRule.id,entryVersion:1,expectedPersonalVersion:3}),/归档/)
 // 旧 save/withdraw 语义不变：撤回副本后不输出，请求日志与撤回行不泄露正文
 const withdrawn=await personal.withdraw(owner,{requestId:randomUUID(),expectedVersion:3,entryId:memoryCopy.id})
 assert.equal(withdrawn.version,4);assert.equal(withdrawn.entries.some(e=>e.id===memoryCopy.id),false)
 const requests=JSON.stringify((await pool.query('select * from teloa_personal_memory_requests')).rows)
 for(const text of ['只做Mac','记忆独有内容','归档正文'])assert.equal(requests.includes(text),false,'请求日志只保存摘要与身份')
 const row=(await pool.query('select markdown,state from teloa_personal_memory_entries where id=$1',[memoryCopy.id])).rows[0]
 assert.deepEqual(row,{markdown:null,state:'withdrawn'})
 assert.equal((await pool.query("select count(*)::int n from teloa_project_context_entries where project_id=$1 and state='active'",[project.id])).rows[0].n,1,'采用不改写项目侧条目')
})
