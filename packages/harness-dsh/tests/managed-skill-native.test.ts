import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

// 只从当前 SkillRegistry 的真实依赖解析公开 scope API，不硬编码 pnpm 路径或另选版本。
// harness 尚未直接依赖 scope；本测试不改变 package 或宿主装配。
const skillRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh-skill'))
const {createScope}=await import(pathToFileURL(skillRequire.resolve('@deepseek-ai/dsh-scope')).href) as {
  createScope:(ctx:Context,key:object,options?:{parent:object})=>{ctx:Context;dispose:()=>Promise<void>}
}

async function setup(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-managed-skill-'))),ctx=new Context()
  t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
  await ctx.plugin(SkillRegistry)
  const managedRoot=join(root,'.runtime/teloa/skills')
  await mkdir(managedRoot,{recursive:true})
  let provider!:SkillFileSystem.FileSystemSkillProvider
  const unregister=ctx.skills.registerProvider(control=>{
    provider=new SkillFileSystem.FileSystemSkillProvider(ctx,control,{providerName:'teloa-market',includeDefaultRoots:false,customSkillDirs:[managedRoot],watch:false})
    return provider
  })
  t.after(()=>provider.dispose())
  return {root,ctx,managedRoot,provider,unregister}
}
async function bundle(root:string,directoryId:string,name:string,body:string,flags=''){
  const directory=join(root,directoryId),path=join(directory,'SKILL.md')
  await mkdir(directory,{recursive:true})
  await writeFile(path,`---\nname: ${name}\ndescription: 原生受管 Skill 验收\n${flags}---\n\n${body}\n`)
  return {directory,path}
}

test('单一原生注册表：全局受管 provider 跨 cwd 与 scope 可见，preset 项目同名优先且资源根真实',async t=>{
  const {root,ctx,managedRoot}=await setup(t)
  const managed=await bundle(managedRoot,'7f93-install-identity','managed-reference','使用 references/source.txt 核对资料。')
  await mkdir(join(managed.directory,'references'))
  await writeFile(join(managed.directory,'references/source.txt'),'固定附件原文')
  const cwdA=join(root,'project-a'),cwdB=join(root,'project-b')
  await mkdir(cwdA,{recursive:true});await mkdir(cwdB,{recursive:true})
  const project=await bundle(join(cwdA,'.agents/skills'),'project-folder','managed-reference','项目自己的同名 Skill')
  const standingKey={},agentKey={},otherKey={}
  const standing=createScope(ctx,standingKey),agent=createScope(ctx,agentKey,{parent:standingKey}),other=createScope(ctx,otherKey)
  t.after(async()=>{await agent.dispose();await standing.dispose();await other.dispose()})
  // 与 standard preset 相同：filesystem 注册落在 standing scope，复用上面的同一个注册表。
  await standing.ctx.plugin(SkillFileSystem,{providerName:'filesystem',includeDefaultRoots:true,dshHome:join(root,'empty-dsh'),agentsHome:join(root,'empty-agents'),bundledSkillDir:join(root,'empty-bundled'),watch:false})
  for(const options of [{cwd:cwdA},{cwd:cwdB},{cwd:cwdB,scope:standingKey},{cwd:cwdB,scope:agentKey},{cwd:cwdA,scope:otherKey}]){
    const skill=await ctx.skills.get('managed-reference',options)
    assert.ok(skill)
    assert.equal(skill.provider,'teloa-market')
    assert.equal(skill.source,'custom')
    assert.equal(skill.path,managed.path,'目录 ID 与 front matter name 不同仍能按原生 name 读取')
    assert.deepEqual(skill.resourceBase,{kind:'directory',path:managed.directory})
    assert.equal(await readFile(join(skill.resourceBase!.kind==='directory'?skill.resourceBase!.path:'invalid','references/source.txt'),'utf8'),'固定附件原文')
  }
  for(const scope of [standingKey,agentKey]){
    const skill=await ctx.skills.get('managed-reference',{cwd:cwdA,scope})
    assert.ok(skill)
    assert.equal(skill.provider,'filesystem')
    assert.equal(skill.source,'project-agents')
    assert.equal(skill.path,project.path)
    assert.deepEqual(skill.resourceBase,{kind:'directory',path:project.directory})
    assert.equal(skill.content,'项目自己的同名 Skill','原生 parser 返回 trim 后正文，不能拿原始文件 hash 冒充正文 hash')
  }
  assert.equal((await ctx.skills.list({cwd:cwdA,scope:agentKey})).filter(x=>x.name==='managed-reference').length,1,'获胜目录不能把被遮蔽安装也冒充为可调用')
  await standing.dispose()
  assert.equal((await ctx.skills.get('managed-reference',{cwd:cwdA,scope:agentKey}))?.path,managed.path,'移除 preset 提供方后全局受管来源重新获胜')
})

test('原生解析保留 model/user 调用策略，非法 front matter 明确不进入目录',async t=>{
  const {ctx,managedRoot,root}=await setup(t)
  await bundle(managedRoot,'install-user','user-only','用户调用正文','disable-model-invocation: true\nuser-invocable: true\n')
  await bundle(managedRoot,'install-model','model-only','模型调用正文','disable-model-invocation: false\nuser-invocable: false\n')
  await bundle(managedRoot,'install-disabled','neither-invocable','不可调用正文','disable-model-invocation: true\nuser-invocable: false\n')
  await bundle(managedRoot,'invalid-policy','invalid-policy','不应可用','disable-model-invocation: maybe\n')
  const missing=join(managedRoot,'missing-description')
  await mkdir(missing);await writeFile(join(missing,'SKILL.md'),'---\nname: missing-description\n---\n没有 description\n')
  const snapshot=await ctx.skills.snapshot({cwd:root})
  assert.equal(snapshot.complete,true,'无效格式被原生忽略并不导致整体目录不完整；安装器必须另外核对目标候选')
  assert.deepEqual(snapshot.skills.map(x=>x.name).sort(),['model-only','neither-invocable','user-only'])
  for(const [name,modelInvocable,userInvocable] of [['user-only',false,true],['model-only',true,false],['neither-invocable',false,false]] as const){
    const skill=await ctx.skills.get(name,{cwd:root})
    assert.ok(skill)
    assert.deepEqual(skill.invocation,{modelInvocable,userInvocable})
  }
  assert.equal(await ctx.skills.get('missing-description',{cwd:root}),undefined)
  assert.equal(await ctx.skills.get('invalid-policy',{cwd:root}),undefined)
})

test('受管文件变更显式失效原生目录，注销和 dispose 后无旧能力或迟到刷新',async t=>{
  const {ctx,managedRoot,root,provider,unregister}=await setup(t)
  const file=await bundle(managedRoot,'stable-install','before-change','第一版正文')
  assert.deepEqual((await ctx.skills.list({cwd:root})).map(x=>x.name),['before-change'])
  let changes=0
  const off=ctx.on('skills/change',()=>{changes++})
  t.after(off)
  await bundle(managedRoot,'stable-install','after-change','第二版正文','user-invocable: false\n')
  assert.deepEqual((await ctx.skills.list({cwd:root})).map(x=>x.name),['before-change'],'关闭 watcher 后未显式失效时存在缓存，反例证明刷新断言不是恒真')
  provider.observeHostMutation(file.path)
  assert.equal(changes,1)
  assert.deepEqual((await ctx.skills.list({cwd:root})).map(x=>x.name),['after-change'])
  assert.equal(await ctx.skills.get('before-change',{cwd:root}),undefined)
  const current=await ctx.skills.get('after-change',{cwd:root})
  assert.ok(current)
  assert.equal(current.content,'第二版正文')
  assert.deepEqual(current.invocation,{modelInvocable:true,userInvocable:false})
  unregister();await provider.dispose()
  assert.deepEqual(await ctx.skills.list({cwd:root}),[])
  assert.equal(await ctx.skills.get('after-change',{cwd:root}),undefined)
  const afterDispose=changes
  provider.observeHostMutation(file.path)
  assert.equal(changes,afterDispose,'已释放提供方不能借迟到变更使注册表失效')
})
