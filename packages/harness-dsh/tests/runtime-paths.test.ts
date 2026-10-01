import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,realpath,symlink,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import {registerManagedSkills} from '../src/managed-skills-native.ts'
import {canonicalizePath,resolveTeloaRuntime,resolveTeloaWorkspaceRoot,workspaceRefusedForRepository} from '../src/runtime-paths.ts'

// 与受管 Skill 用例一致：借宿主实际依赖的本地文件系统服务，避免另选版本。
const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {
  LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem
}
const digest=(body:string)=>createHash('sha256').update(body).digest('hex')
const 初始运行目录=process.env.TELOA_RUNTIME_ROOT
const 初始工作区=process.env.TELOA_WORKSPACE_ROOT

/**
 * 在一个真实（已 realpath）基目录里造出“真实运行目录”和指向它的软链运行目录。
 * 清理只登记删目录，而且由调用方在 dispose 之后再登记（node:test 的 after 按注册顺序执行）。
 */
async function linkedRuntime(){
  const base=await realpath(await mkdtemp(join(tmpdir(),'teloa-runtime-link-')))
  const real=join(base,'真实运行目录'),link=join(base,'软链运行目录')
  await mkdir(join(real,'skills'),{recursive:true})
  await symlink(real,link,'dir')
  return {base,real,link,clean:()=>rm(base,{recursive:true,force:true})}
}

/** TELOA_RUNTIME_ROOT 是进程级状态：就地设置、同步读完就恢复，不跨用例残留。 */
function withRuntimeRoot<T>(link:string,read:()=>T):T{
  const configured=process.env.TELOA_RUNTIME_ROOT
  process.env.TELOA_RUNTIME_ROOT=link
  try{return read()}
  finally{
    if(configured===undefined)delete process.env.TELOA_RUNTIME_ROOT
    else process.env.TELOA_RUNTIME_ROOT=configured
  }
}

test('规范化取最长已存在祖先的真实路径，再拼回尚未创建的尾段',async t=>{
  const {base,real,link,clean}=await linkedRuntime()
  t.after(clean)
  assert.equal(canonicalizePath(join(link,'skills','未创建','再深一层')),join(real,'skills','未创建','再深一层'))
  assert.equal(canonicalizePath(link),real,'软链本身也要解析到真实目录')
  assert.equal(canonicalizePath(join(base,'从不存在')),join(base,'从不存在'),'祖先没有软链时保持原样')
  assert.equal(withRuntimeRoot(link,()=>resolveTeloaRuntime(base)),real,'配置的运行目录同样按规范路径解析')
  assert.equal(process.env.TELOA_RUNTIME_ROOT,初始运行目录,'用例不得改动进程级环境变量并留给后续用例')
})

/** 与运行目录同样的进程级读法：就地设置、同步读完就恢复。传 undefined 表示读“未配置”的默认值。 */
function withWorkspaceRoot<T>(workspace:string|undefined,read:()=>T):T{
  const configured=process.env.TELOA_WORKSPACE_ROOT
  if(workspace===undefined)delete process.env.TELOA_WORKSPACE_ROOT
  else process.env.TELOA_WORKSPACE_ROOT=workspace
  try{return read()}
  finally{
    if(configured===undefined)delete process.env.TELOA_WORKSPACE_ROOT
    else process.env.TELOA_WORKSPACE_ROOT=configured
  }
}

test('默认工作区落在运行目录里，不再是仓库根',async t=>{
  const {base,real,link,clean}=await linkedRuntime()
  t.after(clean)
  // 未配置工作区时按运行目录派生：会话沙箱的写范围与原生终端的初始目录都不该覆盖仓库本身。
  assert.equal(withWorkspaceRoot(undefined,()=>resolveTeloaWorkspaceRoot(base)),join(base,'.runtime','teloa','workspace'))
  assert.notEqual(withWorkspaceRoot(undefined,()=>resolveTeloaWorkspaceRoot(base)),base,'默认工作区不能是项目根目录')
  // 运行目录被改写时工作区跟着走，验收隔离才不会漏回正式工作区。
  assert.equal(withRuntimeRoot(link,()=>withWorkspaceRoot(undefined,()=>resolveTeloaWorkspaceRoot(base))),join(real,'workspace'))
  // 显式配置的工作区同样按规范路径解析，软链祖先不会让受管 Skill 被判成他源。
  assert.equal(withWorkspaceRoot(link,()=>resolveTeloaWorkspaceRoot(base)),real)
  assert.equal(process.env.TELOA_WORKSPACE_ROOT,初始工作区,'用例不得改动进程级环境变量并留给后续用例')
  assert.equal(process.env.TELOA_RUNTIME_ROOT,初始运行目录,'用例不得改动进程级环境变量并留给后续用例')
})

test('仓库根、其祖先与仓库内运行目录之外的位置都不能作为工作区',async t=>{
  const {base,real,link,clean}=await linkedRuntime()
  t.after(clean)
  const repository=join(real,'仓库')
  await mkdir(join(repository,'packages'),{recursive:true})
  const refused=(workspace:string)=>workspaceRefusedForRepository(workspace,repository)
  // 覆盖仓库：一次已认证会话就能改写整个仓库。
  assert.equal(refused(repository),true,'工作区正是仓库根')
  assert.equal(refused(real),true,'工作区是仓库根的祖先')
  assert.equal(refused('/'),true,'文件系统根同样覆盖仓库')
  // 登记表里的路径是 realpath，仓库根不一定是：两侧都规范化后才判得准。
  assert.equal(refused(link),true,'软链祖先规范化后仍是祖先')
  // 仓库内：只有运行目录之下可用，源码目录会让沙箱与终端直接写在本程序自己的代码上。
  assert.equal(refused(join(repository,'packages')),true,'仓库内的源码目录不能作为工作区')
  assert.equal(refused(join(repository,'packages','harness-dsh')),true,'源码目录的下级同样不行')
  assert.equal(refused(join(repository,'随便一个新目录')),true,'仓库内运行目录之外的位置一律拒绝')
  assert.equal(refused(join(repository,'.runtime')),true,'运行目录本身也拒绝：其下有数据库口令与全部会话日志')
  assert.equal(refused(join(repository,'.runtimex')),true,'同前缀但不是运行目录的兄弟目录不能蒙混过关')
  assert.equal(refused(join(repository,'.runtime','teloa','workspace')),false,'正式专用工作区在运行目录之下')
  assert.equal(refused(join(repository,'.runtime','teloa-e2e-abc','workspace')),false,'验收隔离工作区同样在运行目录之下')
  // 仓库之外：那是用户自己的目录，本程序不替他决定。
  assert.equal(refused(join(base,'别处')),false,'仓库之外的同级目录允许')
  assert.equal(refused(join(real,'仓库-另一个')),false,'同前缀但不同段的目录既不是祖先也不在仓库内')
})

test('软链运行目录下的受管 Skill 不能被判为 shadowed',async t=>{
  const {base,link,clean}=await linkedRuntime()
  const runtimeRoot=withRuntimeRoot(link,()=>resolveTeloaRuntime(base)),managedRoot=resolve(runtimeRoot,'skills')
  const installationId='01997c2d-3c00-7000-8000-000000000001'
  const directory=join(managedRoot,installationId),path=join(directory,'SKILL.md')
  await mkdir(directory,{recursive:true})
  await writeFile(path,'---\nname: fixed-method\ndescription: 固定方法\n---\n\n  正文原生裁剪  \n')

  const ctx=new Context()
  t.after(()=>ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:base})
  const manager=registerManagedSkills(ctx,managedRoot)
  t.after(()=>manager.dispose())
  // 登记在最后：after 按注册顺序执行，临时目录必须等 ctx 与受管 provider 都释放完再删。
  t.after(clean)

  const value=await manager.observe('fixed-method',{cwd:base},{path,bodyHash:digest('正文原生裁剪'),modelInvocable:true,userInvocable:true})
  assert.notEqual(value.state,'shadowed','软链祖先不得让受管 Skill 被判成他源')
  assert.equal(value.state,'available')
  assert.equal(value.current?.path,path)
})
