import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFileSync,unlinkSync,symlinkSync} from 'node:fs'
import {mkdtemp,mkdir,rm,writeFile,symlink,link,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setupRoleWork,identity} from './role-work-test-fixture.ts'
import {AuthorizedLocalMaterialCatalog,initializeAuthorizedLocalMaterials} from '../src/capabilities/authorized-local-material-catalog.ts'
import {ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'
import {combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'

test('单份本机原件失效不阻断组合资料目录，原记录保留且撤权或换根仍拒绝',{timeout:30000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close());await initializeAuthorizedLocalMaterials(f.pool)
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-list-fault-'))),other=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-list-other-')))
 t.after(()=>rm(root,{recursive:true,force:true}));t.after(()=>rm(other,{recursive:true,force:true}))
 const actor={ownerId:randomUUID(),kind:'human' as const,scopeIds:['general']},context={actor,scopeIds:['general']}
 let permitted=true,currentRoot=root,lateRevoke=false,lateSwap=false
 const catalog=new AuthorizedLocalMaterialCatalog(f.pool,identity,{authorize:async()=>({workspaceRoot:currentRoot,assertCurrent:()=>{assert.ok(permitted)},isProtectedPath:path=>{
  if(path===join(root,'失效.md')){if(lateRevoke)permitted=false;if(lateSwap){currentRoot=other;return true}}return false
 }})})
 await writeFile(join(root,'正常.md'),'# 正常资料\n');await writeFile(join(root,'失效.md'),'# 原登记资料\n')
 const a=await catalog.register(actor,{requestId:randomUUID(),title:'正常资料',path:'正常.md',scopeIds:['general']}),b=await catalog.register(actor,{requestId:randomUUID(),title:'原登记资料',path:'失效.md',scopeIds:['general']})
 const publicReference={id:'public_fixture',title:'公共资料',source:'fixture.md',version:'a'.repeat(64),bytes:1}
 const empty={list:async()=>({schema:'teloa.reference-list/v1' as const,references:[]}),read:async()=>{throw Error('empty catalog')}}
 const combined=combineReferenceCatalogs({...empty,list:async()=>({schema:'teloa.reference-list/v1' as const,references:[publicReference]})},empty,undefined,catalog)
 const service=new ResourceService(f.pool,combined,identity)
 for(const source of [a,b]){const draft=await service.create(actor,{requestId:randomUUID(),title:source.title,sourceId:source.id,sourceVersion:source.version,scopeIds:['general']});await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version})}
 const original=await service.list(actor);await rm(join(root,'失效.md'))
 assert.deepEqual((await catalog.list(context)).references,[a])
 assert.deepEqual((await combined.list(context)).references,[publicReference,a])
 assert.deepEqual(await service.list(actor),original,'目录隔离不能删除、撤回或改写原资料及草稿')
 assert.equal((await catalog.read(a.id,a.version,context)).text,'# 正常资料\n')
 await assert.rejects(catalog.read(b.id,b.version,context),{code:'teloa/forbidden'});await assert.rejects(catalog.current(b.id,context),{code:'teloa/forbidden'})
 permitted=false;await assert.rejects(catalog.list(context),{code:'teloa/forbidden'});permitted=true
 await writeFile(join(root,'失效.md'),'# 原登记资料\n');lateRevoke=true
 await assert.rejects(catalog.list(context),{code:'teloa/forbidden'});permitted=true;lateRevoke=false;lateSwap=true
 await assert.rejects(catalog.list(context),{code:'teloa/forbidden'})
 lateSwap=false;currentRoot=root
 await f.pool.query('update teloa_authorized_local_materials set workspace_root=$1 where id=$2',[other,a.id.slice('local_material_'.length)])
 await assert.rejects(catalog.list(context),{code:'teloa/forbidden'},'登记根损坏不能被当作单个原件不可用而吞掉')
})

test('读取途中普通原件改版给出版本冲突，换成链接仍按权限失败拒绝',{timeout:30000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close());await initializeAuthorizedLocalMaterials(f.pool)
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-read-race-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const actor={ownerId:randomUUID(),kind:'human' as const,scopeIds:['general']},path=join(root,'原件.md'),context={actor,scopeIds:['general']}
 await writeFile(path,'# 原版本\n');await writeFile(join(root,'替换.md'),'# 不可沿链接读取\n')
 let checks=0,mutation:(()=>void)|undefined
 const catalog=new AuthorizedLocalMaterialCatalog(f.pool,identity,{authorize:async()=>({workspaceRoot:root,assertCurrent:()=>{},isProtectedPath:()=>{if(mutation&&++checks===3)mutation();return false}})})
 const source=await catalog.register(actor,{requestId:randomUUID(),title:'原件',path:'原件.md',scopeIds:['general']})
 mutation=()=>writeFileSync(path,'# 读取期间变更后的原件\n')
 await assert.rejects(catalog.read(source.id,source.version,context),{code:'teloa/version-conflict'})
 checks=0;mutation=()=>{unlinkSync(path);symlinkSync(join(root,'替换.md'),path)}
 await assert.rejects(catalog.read(source.id,source.version,context),{code:'teloa/forbidden'})
})

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
 await assert.rejects(catalog.register(actor,{...command,requestId:randomUUID(),title:'另一个登记标题'}),{code:'teloa/conflict',details:{reason:'local-material-registration-mismatch'}})
 assert.equal((await catalog.list(context)).references[0]?.title,'跟踪周报','登记冲突不能改写既有来源标题')
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
