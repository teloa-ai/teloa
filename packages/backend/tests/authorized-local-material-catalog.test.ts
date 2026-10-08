import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,rm,writeFile,symlink,link,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setupRoleWork,identity} from './role-work-test-fixture.ts'
import {AuthorizedLocalMaterialCatalog,initializeAuthorizedLocalMaterials} from '../src/capabilities/authorized-local-material-catalog.ts'
import {ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'

test('本人预览已加入本机资料，锁定真实资料及正文版本且不扩大授权',{timeout:30000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close());await initializeAuthorizedLocalMaterials(f.pool)
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-preview-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const actor={ownerId:randomUUID(),kind:'human' as const,scopeIds:['general']},text='# 本人本机原件\n第一版正文\n';let permitted=true,reads=0
 const catalog=new AuthorizedLocalMaterialCatalog(f.pool,identity,{authorize:async()=>({workspaceRoot:root,assertCurrent:()=>{assert.ok(permitted)},isProtectedPath:()=>{reads++;return false}})})
 await writeFile(join(root,'原件.md'),text)
 const source=await catalog.register(actor,{requestId:randomUUID(),title:'原件',path:'原件.md',scopeIds:['general']})
 const service=new ResourceService(f.pool,catalog,identity),draft=await service.create(actor,{requestId:randomUUID(),title:'本机资料',sourceId:source.id,sourceVersion:source.version,scopeIds:['general']})
 const resource=await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
 const preview=service as ResourceService&{readContent:(principal:ResourceActor,input:unknown)=>Promise<{resource:typeof resource;text:string}>}
 assert.equal(typeof preview.readContent,'function','已加入的本机原件需有本人只读正文入口')
 const command={resourceId:resource.id,expectedVersion:resource.version,sourceVersion:resource.sourceVersion}
 assert.deepEqual(await preview.readContent(actor,command),{resource,text});assert.deepEqual(await service.getResource(actor,{resourceId:resource.id}),resource)
 reads=0
 await assert.rejects(preview.readContent({...actor,kind:'agent'},command),{code:'teloa/forbidden'})
 await assert.rejects(preview.readContent({...actor,ownerId:'other'},command),{code:'teloa/forbidden'})
 await assert.rejects(preview.readContent({...actor,scopeIds:['other']},command),{code:'teloa/forbidden'})
 await assert.rejects(preview.readContent(actor,{...command,expectedVersion:resource.version+1}),{code:'teloa/version-conflict'})
 await assert.rejects(preview.readContent(actor,{...command,sourceVersion:'a'.repeat(64)}),{code:'teloa/version-conflict'})
 await assert.rejects(preview.readContent(actor,{...command,path:'原件.md'}),{code:'teloa/invalid-input'});assert.equal(reads,0)
 permitted=false;await assert.rejects(preview.readContent(actor,command));permitted=true
 await writeFile(join(root,'原件.md'),'# 新原件版本\n');await assert.rejects(preview.readContent(actor,command),{code:'teloa/version-conflict'})
 await service.withdraw(actor,{resourceId:resource.id,expectedVersion:resource.version})
 await assert.rejects(preview.readContent(actor,{...command,expectedVersion:resource.version+1}),{code:'teloa/resource-withdrawn'})
})

test('单份已授权原件 current 不枚举或读取同范围的另一份已删除原件',{timeout:30000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close())
 await initializeAuthorizedLocalMaterials(f.pool)
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-current-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const actor={ownerId:randomUUID(),kind:'human' as const,scopeIds:['general']},context={actor,scopeIds:['general']},reads:string[]=[]
 const catalog=new AuthorizedLocalMaterialCatalog(f.pool,identity,{authorize:async()=>({workspaceRoot:root,assertCurrent:()=>{},isProtectedPath:path=>{reads.push(path);return false}})})
 await writeFile(join(root,'A.md'),'# 仅此原件已授权\n');await writeFile(join(root,'B.md'),'# 另一份本人原件\n')
 const register=(path:string)=>catalog.register(actor,{requestId:randomUUID(),title:path,path,scopeIds:['general']})
 const a=await register('A.md');await register('B.md');await rm(join(root,'B.md'));reads.length=0
 const current=await catalog.current(a.id,context)
 assert.deepEqual(current,a);assert.equal('text' in current,false);assert.ok(reads.length>0);assert.ok(reads.every(path=>path===join(root,'A.md')))
 await assert.rejects(catalog.current(a.id,{actor:{...actor,ownerId:'other'},scopeIds:['general']}),{code:'teloa/forbidden'})
 await assert.rejects(catalog.current(a.id,{actor,scopeIds:['research']}),{code:'teloa/forbidden'})
})

test('本人明确登记本机 Markdown；来源真实改版，越权、替换根、链接及不可信原件拒绝',{timeout:30000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close())
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-material-')));t.after(()=>rm(root,{recursive:true,force:true}))
 let api:Record<string,any>={}
 try{api=await import('../src/capabilities/authorized-local-material-catalog.ts')}catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw error}
 assert.equal(typeof api.AuthorizedLocalMaterialCatalog,'function','需要真实持久本人本机原件登记服务')
 await api.initializeAuthorizedLocalMaterials(f.pool)
 const owner=randomUUID(),actor={ownerId:owner,kind:'human' as const,scopeIds:['general']},context={actor,scopeIds:['general']},other=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-other-')));t.after(()=>rm(other,{recursive:true,force:true}))
 let active=true,currentRoot=root,generation=0
 const ports={authorize:async(principal:typeof actor,_scopeIds:readonly string[],operation:string)=>{if(!active||principal.ownerId!==owner)throw Error('本人许可拒绝');const captured=generation;return {workspaceRoot:currentRoot,isProtectedPath:(path:string)=>path.endsWith('/credentials.md'),assertCurrent(){if(!active||generation!==captured)throw Error('当前工作区许可已变化')}}}}
 const catalog=new api.AuthorizedLocalMaterialCatalog(f.pool,identity,ports)
 await writeFile(join(root,'周报.md'),'# 首轮\n完成3项\n')
 const command={requestId:randomUUID(),title:'跟踪周报',path:'周报.md',scopeIds:['general']}
 const [registered,repeated]=await Promise.all([catalog.register(actor,command),catalog.register(actor,command)]);assert.deepEqual(registered,repeated);assert.match(registered.id,/^local_material_/)
 assert.equal((await catalog.list(context)).references.length,1)
 assert.match((await catalog.read(registered.id,registered.version,context)).text,/完成3项/)
 await writeFile(join(root,'周报.md'),'# 第二轮\n完成5项\n')
 const next=(await catalog.list(context)).references[0];assert.equal(next.id,registered.id);assert.notEqual(next.version,registered.version)
 assert.deepEqual(await catalog.register(actor,command),registered,'未知结果重试须使用原登记回执，不采纳后改版本')
 await assert.rejects(catalog.read(registered.id,registered.version,context),{code:'teloa/version-conflict'})
 assert.match((await catalog.read(next.id,next.version,context)).text,/完成5项/)
 await assert.rejects(catalog.register({...actor,kind:'agent'},command),{code:'teloa/forbidden'})
 await assert.rejects(catalog.register(actor,{...command,requestId:randomUUID(),ownerId:owner}),{code:'teloa/invalid-input'})
 await assert.rejects(catalog.register(actor,{...command,requestId:command.requestId,title:'更换原请求'}),{code:'teloa/conflict'})
 await assert.rejects(catalog.read(next.id,next.version,{actor:{...actor,ownerId:'other'},scopeIds:['general']}),{code:'teloa/forbidden'})
 await assert.rejects(catalog.read(next.id,next.version,{actor:{...actor,scopeIds:['research']},scopeIds:['research']}),{code:'teloa/forbidden'})
 for(const path of ['../周报.md',join(root,'周报.md'),'folder/../周报.md','file.txt'])await assert.rejects(catalog.register(actor,{...command,requestId:randomUUID(),path}),{code:'teloa/invalid-input'})
 await writeFile(join(root,'credentials.md'),'secret');await symlink(join(root,'周报.md'),join(root,'link.md'));await link(join(root,'周报.md'),join(root,'hard.md'))
 await writeFile(join(root,'bad.md'),Buffer.from([0xff]));await writeFile(join(root,'large.md'),Buffer.alloc(128*1024+1))
 await mkdir(join(root,'sub'));await symlink(other,join(root,'sub','outside'));await writeFile(join(other,'外部.md'),'不允许越界')
 for(const path of ['credentials.md','link.md','hard.md','bad.md','large.md','sub/outside/外部.md'])await assert.rejects(catalog.register(actor,{...command,requestId:randomUUID(),path}),{code:'teloa/forbidden'})
 currentRoot=other;generation++;await assert.rejects(catalog.read(next.id,next.version,context),{code:'teloa/forbidden'})
 currentRoot=root;active=false;await assert.rejects(catalog.list(context),{code:'teloa/forbidden'})
 const missing=new api.AuthorizedLocalMaterialCatalog(f.pool,identity);await assert.rejects(missing.register(actor,{...command,requestId:randomUUID()}),{code:'teloa/forbidden'})
})
