import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {SkillRegistry,type SkillCandidate} from '@deepseek-ai/dsh-skill'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import {WorkError} from '@teloa/contract'
import {inspectNativeSkillDirectory,registerManagedSkills} from '../src/managed-skills-native.ts'
import {ManagedSkillFiles} from '../src/managed-skill-files.ts'
import {createManagedAvailabilitySync} from '../src/managed-skill-availability-sync.ts'
import {withPresetReadScope} from '../src/preset-read-scope.ts'
import ts from 'typescript'

/** 执行宿主实际第三参观测回调，避免测试复制另一份正确接线。 */
async function hostSkillObserver(bindings:Record<string,unknown>){
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true)
 let callback:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='skillInstallationsHandler'&&node.initializer&&ts.isCallExpression(node.initializer))callback=node.initializer.arguments[2];ts.forEachChild(node,visit)}
 visit(tree);assert.ok(callback)
 const code=ts.transpileModule('const observer='+callback.getText(tree)+';return observer',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 return new Function(...Object.keys(bindings),code)(...Object.values(bindings)) as (id:string)=>Promise<{installationId:string;state:string}>
}

// 使用宿主实际 DSH 所依赖的公开本地文件系统服务，避免另选版本或改动依赖清单。
const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {
  LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem
}
const digest=(body:string)=>createHash('sha256').update(body).digest('hex')
async function setup(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-managed-adapter-'))),ctx=new Context()
  t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
  await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:root})
  return {root,ctx}
}
async function skill(root:string,id:string,name='fixed-method',flags=''){
  const directory=join(root,id),path=join(directory,'SKILL.md')
  await mkdir(directory,{recursive:true})
  await writeFile(path,`---\nname: ${name}\ndescription: 固定方法\n${flags}---\n\n  正文原生裁剪  \n`)
  return {directory,path}
}
const installationId='01997c2d-3c00-7000-8000-000000000001'
const snapshot=(overrides:Record<string,unknown>={})=>[{
  installationId,installationState:'installed' as const,installationVersion:2,
  availability:'enabled' as const,availabilityVersion:1,
  native:{name:'fixed-method',description:'固定方法',modelInvocable:true,userInvocable:true,bodyHash:digest('正文原生裁剪')},
  ...overrides,
}]

test('宿主四项并行安装观测持有完整稳定读取，后项刷新不能把原可用技能打断为missing', {timeout:10000},async t=>{
 const {root,ctx}=await setup(t),rows:ReturnType<typeof snapshot>=[],records=new Map(),bundles=new Map()
 for(let index=1;index<=4;index++){
  const id='01997c2d-3c00-7000-8000-'+String(index).padStart(12,'0'),name='fixed-method-'+index,target=await skill(root,id,name)
  const native={...snapshot()[0]!.native,name},bytes=await readFile(target.path),hash=createHash('sha256').update(bytes).digest('hex'),bundleHash=digest(JSON.stringify([['SKILL.md',hash]]))
  rows.push({...snapshot()[0]!,installationId:id,native})
  records.set(id,{id,state:'installed',source:{kind:'atomic',contentId:id},native,bundleHash})
  bundles.set(id,{entryPath:'SKILL.md',files:[{path:'SKILL.md',hash,bytes}],bundleHash})
 }
 let enter!:()=>void,release!:()=>void,gated=true,leases=0,disposed=0
 const entered=new Promise<void>(done=>{enter=done}),gate=new Promise<void>(done=>{release=done})
 t.after(()=>release())
 const manager=registerManagedSkills(ctx,root,{initial:rows,verifyUsable:async id=>{if(id===rows[0]!.installationId&&gated){gated=false;enter();await gate}}})
 t.after(()=>manager.dispose())
 const availabilitySync=createManagedAvailabilitySync({deny:()=>manager.denyWhileRefreshing(),read:async()=>rows,replace:value=>manager.replaceAvailability(value)})
 const managedFiles=new ManagedSkillFiles(root,directory=>inspectNativeSkillDirectory(ctx,directory),path=>manager.invalidate(path))
 class ReadSource{async read(_owner:string,input:{contentId:string}){return bundles.get(input.contentId)}}
 const observer=await hostSkillObserver({availabilitySync,skillInstallationService:async()=>({get:async(_owner:string,{installationId}:{installationId:string})=>records.get(installationId)}),resources:{database:async()=>({pool:{}})},randomUUID:()=>installationId,MarketContentStore:class{},IndustryLoadService:class{},createIndustryLoadSource:()=>undefined,SkillInstallSource:ReadSource,industryModelProbe:undefined,managedFiles,managedNative:manager,withPresetReadScope,ctx:{agentPresets:{acquireScope:async()=>{leases++;return {key:undefined,async [Symbol.asyncDispose](){disposed++}}}}},workspaceRoot:root,owner:'isolated-owner',WorkError})
 const first=observer(rows[0]!.installationId)
 await entered
 const rest=rows.slice(1).map(row=>observer(row.installationId))
 await new Promise<void>(done=>setImmediate(done));release()
 const result=await Promise.all([first,...rest])
 assert.deepEqual(result.map(row=>row.state),['available','available','available','available'])
 assert.deepEqual(result.map(row=>row.installationId),rows.map(row=>row.installationId));assert.equal(leases,4);assert.equal(disposed,4)
 // 固定文件、包与正文核验不因稳定读取而放宽；错误仍传播。
 const original=bundles.get(rows[0]!.installationId)
 bundles.set(rows[0]!.installationId,{...original,bundleHash:'a'.repeat(64)})
 await assert.rejects(observer(rows[0]!.installationId),{code:'teloa/storage-corrupt'})
})
function fallback(ctx:Context){
  return ctx.skills.registerProvider(()=>({
    name:'lower-provider',
    list:async()=>[{name:'fixed-method',description:'不应静默回退',invocation:{modelInvocable:true,userInvocable:true},source:'user-dsh',provider:'lower-provider',rank:400,locator:'lower'} satisfies SkillCandidate],
    get:async()=>({name:'fixed-method',description:'不应静默回退',invocation:{modelInvocable:true,userInvocable:true},source:'user-dsh',provider:'lower-provider',content:'次选正文'}),
  }))
}

test('inspect 复用原生 parser 与真实 ctx.fs，按目标目录精确选择且不注册能力',async t=>{
  const {root,ctx}=await setup(t),target=await skill(root,'安装ID与原生名称不同'),sibling=await skill(root,'other','other-method')
  const paths:string[]=[],read=ctx.fs.readText.bind(ctx.fs)
  ctx.fs.readText=async(target,signal)=>{paths.push(target.displayPath);return read(target,signal)}
  const value=await inspectNativeSkillDirectory(ctx,target.directory)
  assert.deepEqual(value,{name:'fixed-method',description:'固定方法',modelInvocable:true,userInvocable:true,bodyHash:digest('正文原生裁剪')})
  assert.ok(paths.includes(target.path),'必须经正式 ctx.fs 读取实际入口')
  assert.notEqual(value.name,'other-method','不能拿同父目录的有效 Skill 代替目标')
  assert.deepEqual(await ctx.skills.list({cwd:root}),[],'检查临时 provider 不注册到当前运行目录')
  await rm(target.path)
  await assert.rejects(inspectNativeSkillDirectory(ctx,target.directory),{code:'teloa/invalid-input'})
  assert.ok(paths.includes(sibling.path))
})

test('inspect 无效 front matter 明确拒绝，真实文件系统拒读不能回落 Node 读取',async t=>{
  const {root,ctx}=await setup(t),target=await skill(root,'item')
  await writeFile(target.path,'---\nname: fixed-method\n---\n缺 description')
  await assert.rejects(inspectNativeSkillDirectory(ctx,target.directory),{code:'teloa/invalid-input'})
  await skill(root,'item')
  const rejection=new WorkError('teloa/forbidden','本执行世界不可读取该文件')
  ctx.fs.readText=async()=>{throw rejection}
  await assert.rejects(inspectNativeSkillDirectory(ctx,target.directory),error=>error===rejection)
})

test('注册复用原生目录，实际路径、正文和调用策略全匹配才 available',async t=>{
  const {root,ctx}=await setup(t),target=await skill(root,'install','fixed-method','disable-model-invocation: true\nuser-invocable: true\n')
  const manager=registerManagedSkills(ctx,root)
  t.after(()=>manager.dispose())
  const expected={path:target.path,bodyHash:digest('正文原生裁剪'),modelInvocable:false,userInvocable:true}
  const value=await manager.observe('fixed-method',{cwd:root},expected)
  assert.equal(value.state,'available')
  assert.equal(value.current?.provider,'teloa-market')
  assert.equal(value.current?.source,'custom')
  assert.equal(value.current?.path,target.path)
  assert.deepEqual(value.current?.resourceBase,{kind:'directory',path:target.directory})
  assert.equal(value.current?.modelInvocable,false,'安装可用不改变原生禁止模型调用策略')
  assert.equal((await manager.observe('fixed-method',{cwd:root},{...expected,bodyHash:'a'.repeat(64)})).reason,'content-changed')
  assert.equal((await manager.observe('fixed-method',{cwd:root},{...expected,modelInvocable:true})).state,'shadowed')
  assert.equal((await manager.observe('fixed-method',{cwd:root},{...expected,path:join(root,'other','SKILL.md')})).reason,'different-source')
  assert.deepEqual(await manager.observe('missing-method',{cwd:root},expected),{state:'missing',current:null})
  const other=await skill(root,'other-install','fixed-method')
  const remove=ctx.skills.register({name:'fixed-method',description:'更高优先级来源',source:'runtime',content:'其他正文',path:other.path,resourceBase:{kind:'directory',path:other.directory}})
  const shadowed=await manager.observe('fixed-method',{cwd:root},expected)
  assert.equal(shadowed.state,'shadowed');assert.equal(shadowed.reason,'different-source')
  assert.equal(shadowed.current?.provider,'runtime');assert.equal(shadowed.current?.path,other.path)
  remove()
  assert.equal((await manager.observe('fixed-method',{cwd:root},expected)).state,'available')
})

test('显式刷新观察原生变更；释放后目录消失且不再允许观察',async t=>{
  const {root,ctx}=await setup(t),target=await skill(root,'install')
  const manager=registerManagedSkills(ctx,root)
  t.after(()=>manager.dispose())
  const expected={path:target.path,bodyHash:digest('正文原生裁剪'),modelInvocable:true,userInvocable:true}
  assert.equal((await manager.observe('fixed-method',{cwd:root},expected)).state,'available')
  await skill(root,'install','fixed-method','user-invocable: false\n')
  manager.invalidate(target.path)
  const changed=await manager.observe('fixed-method',{cwd:root},expected)
  assert.equal(changed.state,'shadowed');assert.equal(changed.reason,'content-changed')
  assert.equal(changed.current?.userInvocable,false)
  await manager.dispose();await manager.dispose()
  assert.deepEqual(await ctx.skills.list({cwd:root}),[])
  await assert.rejects(manager.observe('fixed-method',{cwd:root},expected),{code:'teloa/host-unavailable'})
})

test('原生目录读取失败返回未知错误，不能谎报 missing',async t=>{
  const {root,ctx}=await setup(t),target=await skill(root,'install'),manager=registerManagedSkills(ctx,root)
  t.after(()=>manager.dispose())
  ctx.fs.readText=async()=>{throw new WorkError('teloa/forbidden','文件读取失败')}
  await assert.rejects(manager.observe('fixed-method',{cwd:root},{path:target.path,bodyHash:digest('正文原生裁剪'),modelInvocable:true,userInvocable:true}),{code:'teloa/host-unavailable'})
})

test('停用以同层占位阻止次选 provider，恢复后还原原生 flags 且保留文件',async t=>{
  const {root,ctx}=await setup(t),target=await skill(root,installationId,'fixed-method','disable-model-invocation: false\nuser-invocable: true\n')
  const manager=registerManagedSkills(ctx,root,{initial:snapshot()}),removeFallback=fallback(ctx)
  t.after(()=>{removeFallback();return manager.dispose()})
  assert.equal((await ctx.skills.get('fixed-method',{cwd:root}))?.provider,'teloa-market')
  manager.replaceAvailability(snapshot({availability:'disabled',availabilityVersion:2}))
  const listed=(await ctx.skills.list({cwd:root})).find(item=>item.name==='fixed-method')
  assert.equal(listed?.provider,'teloa-market','disabled 名称必须继续由受管 provider 占位')
  assert.deepEqual(listed?.invocation,{modelInvocable:false,userInvocable:false})
  assert.equal(await ctx.skills.get('fixed-method',{cwd:root}),undefined,'winner 不可加载后不能回落次选 provider')
  assert.deepEqual(await manager.observe('fixed-method',{cwd:root},{path:target.path,bodyHash:digest('正文原生裁剪'),modelInvocable:true,userInvocable:true}),{state:'disabled',current:null})
  assert.match(await (await import('node:fs/promises')).readFile(target.path,'utf8'),/正文原生裁剪/,'停用不删除已发任务仍引用的附件')
  manager.replaceAvailability(snapshot({availability:'enabled',availabilityVersion:3}))
  const restored=await ctx.skills.get('fixed-method',{cwd:root})
  assert.equal(restored?.provider,'teloa-market')
  assert.deepEqual(restored?.invocation,{modelInvocable:true,userInvocable:true},'恢复必须使用原生不可变 flags')
})

test('启动快照含 disabled 与 preparing 时立即占位，未知目录不进入目录',async t=>{
  const {root,ctx}=await setup(t)
  await skill(root,installationId)
  const preparingId='01997c2d-3c00-7000-8000-000000000002'
  await skill(root,preparingId,'preparing-method')
  await skill(root,'unknown-installation','unknown-method')
  const manager=registerManagedSkills(ctx,root,{initial:[...snapshot({availability:'disabled',availabilityVersion:4}),{
    installationId:preparingId,installationState:'preparing',installationVersion:1,availability:'enabled',availabilityVersion:1,
    native:{name:'preparing-method',description:'固定方法',modelInvocable:true,userInvocable:true,bodyHash:digest('正文原生裁剪')},
  }]})
  t.after(()=>manager.dispose())
  const names=await ctx.skills.list({cwd:root})
  assert.deepEqual(names.map(item=>item.name),['fixed-method','preparing-method'])
  assert.equal(await ctx.skills.get('fixed-method',{cwd:root}),undefined)
  assert.equal(await ctx.skills.get('preparing-method',{cwd:root}),undefined)
  assert.equal(await ctx.skills.get('unknown-method',{cwd:root}),undefined)
})

test('刷新未知时保留占位，快照双版本均不可倒退或遗漏已有安装',async t=>{
  const {root,ctx}=await setup(t)
  await skill(root,installationId)
  const manager=registerManagedSkills(ctx,root,{initial:snapshot()}),removeFallback=fallback(ctx)
  t.after(()=>{removeFallback();return manager.dispose()})
  manager.denyWhileRefreshing()
  assert.equal((await ctx.skills.list({cwd:root}))[0]?.provider,'teloa-market')
  assert.equal(await ctx.skills.get('fixed-method',{cwd:root}),undefined)
  assert.throws(()=>manager.replaceAvailability(snapshot({installationVersion:1})),{code:'teloa/storage-corrupt'})
  assert.throws(()=>manager.replaceAvailability(snapshot({availabilityVersion:0})),{code:'teloa/storage-corrupt'})
  assert.throws(()=>manager.replaceAvailability([]),{code:'teloa/storage-corrupt'})
  manager.replaceAvailability(snapshot({installationVersion:3,availabilityVersion:2}))
  assert.equal((await ctx.skills.get('fixed-method',{cwd:root}))?.provider,'teloa-market')
})

test('get 读取途中停用时按 generation 拒绝旧正文',async t=>{
  const {root,ctx}=await setup(t),target=await skill(root,installationId)
  const manager=registerManagedSkills(ctx,root,{initial:snapshot()})
  t.after(()=>manager.dispose())
  await ctx.skills.list({cwd:root})
  let start!:()=>void,unblock!:()=>void
  const original=ctx.fs.readText.bind(ctx.fs),started=new Promise<void>(resolve=>{start=resolve}),release=new Promise<void>(resolve=>{unblock=resolve})
  let block=true
  ctx.fs.readText=async(file,signal)=>{
    if(block&&file.displayPath===target.path){block=false;start();await release}
    return original(file,signal)
  }
  const loading=ctx.skills.get('fixed-method',{cwd:root})
  await started
  manager.replaceAvailability(snapshot({availability:'disabled',availabilityVersion:2}))
  unblock()
  assert.equal(await loading,undefined)
})

test('全局选择版本递增后同名候选原子切换，刷新期间不读取旧版且不能倒退',async t=>{
  const {root,ctx}=await setup(t),old=await skill(root,installationId),nextId='01997c2d-3c00-7000-8000-000000000009',next=await skill(root,nextId,'fixed-method','user-invocable: false\n')
  const manager=registerManagedSkills(ctx,root,{initial:snapshot({selectionVersion:1})})
  t.after(()=>manager.dispose())
  const before=await ctx.skills.get('fixed-method',{cwd:root});assert.equal(before?.path,old.path);assert.equal(before?.invocation.userInvocable,true)
  manager.denyWhileRefreshing();assert.equal(await ctx.skills.get('fixed-method',{cwd:root}),undefined)
  manager.replaceAvailability(snapshot({installationId:nextId,selectionVersion:2,native:{name:'fixed-method',description:'固定方法',modelInvocable:true,userInvocable:false,bodyHash:digest('正文原生裁剪')}}))
  const after=await ctx.skills.get('fixed-method',{cwd:root});assert.equal(after?.path,next.path);assert.equal(after?.invocation.userInvocable,false)
  assert.throws(()=>manager.replaceAvailability(snapshot({selectionVersion:1})),{code:'teloa/storage-corrupt'})
  assert.throws(()=>manager.replaceAvailability(snapshot({installationId,selectionVersion:2})),{code:'teloa/storage-corrupt'})
})

test('普通会话读取受管技能时逐次重验模型，旧候选缓存不能绕过且不回退同名来源',async t=>{
  const {root,ctx}=await setup(t),plainId='01997c2d-3c00-7000-8000-000000000010'
  await skill(root,installationId)
  await skill(root,plainId,'plain-method')
  let ready=true
  const verified:string[]=[],unavailable=new WorkError('teloa/dependency-unavailable','此技能需要的本地模型尚未就绪。')
  const manager=registerManagedSkills(ctx,root,{initial:[...snapshot(),{
    installationId:plainId,installationState:'installed',installationVersion:2,availability:'enabled',availabilityVersion:1,
    native:{name:'plain-method',description:'固定方法',modelInvocable:true,userInvocable:true,bodyHash:digest('正文原生裁剪')},
  }],verifyUsable:async id=>{
    verified.push(id)
    if(id===installationId&&!ready)throw unavailable
  }}),removeFallback=fallback(ctx)
  t.after(()=>{removeFallback();return manager.dispose()})
  const lookup={cwd:root}
  // 先让真实 DSH registry 缓存获胜候选；后续不修改文件、不刷新目录、不替换安装快照。
  assert.equal((await ctx.skills.list(lookup)).find(value=>value.name==='fixed-method')?.provider,'teloa-market')
  assert.deepEqual(verified,[],'目录发现本身不运行技能或准备模型')
  assert.equal((await ctx.skills.get('fixed-method',lookup))?.content,'正文原生裁剪')
  assert.deepEqual(verified,[installationId])
  ready=false
  await assert.rejects(ctx.skills.get('fixed-method',lookup),error=>error===unavailable,'必须给出依赖失败，不能静默缺失或返回同名次选正文')
  await assert.rejects(ctx.skills.get('fixed-method',lookup),error=>error===unavailable,'命中既有候选缓存的再次调用也要重验')
  assert.deepEqual(verified,[installationId,installationId,installationId])
  assert.equal((await ctx.skills.get('plain-method',lookup))?.provider,'teloa-market','模型失败只影响依赖它的技能')
  ready=true
  assert.equal((await ctx.skills.get('fixed-method',lookup))?.provider,'teloa-market','恢复后不必重装技能或强制清目录')
  assert.equal(verified.filter(id=>id===installationId).length,4)
})
