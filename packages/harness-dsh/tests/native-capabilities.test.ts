import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'

const projectRoot=fileURLToPath(new URL('../../../',import.meta.url))
test('固定 DSH 原生注册表发现并加载项目 Skill；正文由原生 provider 提供',async t=>{
  const workspace=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-skill-')))
  t.after(()=>rm(workspace,{recursive:true,force:true}))
  const skills=join(workspace,'skills'),skillPath=join(skills,'teloa-reference-brief','SKILL.md')
  await mkdir(join(skills,'teloa-reference-brief'),{recursive:true})
  await writeFile(skillPath,'---\nname: teloa-reference-brief\ndescription: 隔离测试的资料简报技能\n---\n使用 mcp__teloa_reference__read_reference 读取已授权资料。\n')
  const ctx=new Context()
  t.after(()=>ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  const fiber=await ctx.plugin(SkillFileSystem,{includeDefaultRoots:false,customSkillDirs:[skills],watch:false})
  await ctx.plugin(ToolSkill)
  const list=await ctx.skills.list({cwd:projectRoot})
  assert.equal(list.length,1)
  assert.equal(list[0]!.name,'teloa-reference-brief')
  assert.equal(list[0]!.invocation.modelInvocable,true)
  assert.equal(list[0]!.invocation.userInvocable,true)
  const skill=await ctx.skills.get('teloa-reference-brief',{cwd:projectRoot})
  assert.ok(skill)
  assert.equal(skill.path,skillPath)
  assert.ok(skill.content.includes('mcp__teloa_reference__read_reference'))
  const loaded=await ctx.tools.execute({callId:ToolCallId('load-reference-skill'),name:'skill',arguments:{name:'teloa-reference-brief'},signal:AbortSignal.timeout(10000)})
  assert.equal(loaded.isError,false)
  assert.ok(loaded.content.some(item=>item.type==='text'&&item.text.includes(skill.content)))
  await fiber.dispose()
  assert.deepEqual(await ctx.skills.list({cwd:projectRoot}),[])
})
test('固定 DSH MCP 插件经原生 ToolRuntime 真实调用，错误与卸载可观察',{timeout:20000},async t=>{
  const ctx=new Context()
  t.after(()=>ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber=await ctx.plugin(McpClient,{
    serverName:'teloa_reference',transport:'stdio',command:process.execPath,
    args:[projectRoot+'packages/mcp-reference/src/main.ts'],cwd:projectRoot,
    failOnStartupError:true,reconnect:{enabled:false},
  })
  const names=ctx.tools.schemas().map(tool=>tool.name)
  assert.deepEqual(names.sort(),['mcp__teloa_reference__list_references','mcp__teloa_reference__read_reference'])
  assert.deepEqual((await ctx.systemPrompt.assemble()).tools.map(tool=>tool.name).sort(),names)
  let sequence=0
  const execute=(name:string,args:unknown)=>ctx.tools.execute({callId:ToolCallId('native-'+ ++sequence),name,arguments:args,signal:AbortSignal.timeout(10000)})
  const listing=await execute(names[0]!,{})
  assert.equal(listing.isError,false)
  const data=JSON.parse(listing.content.filter(item=>item.type==='text').map(item=>item.text).join('\n')) as {references:{id:string;version:string}[]}
  const read=await execute(names[1]!,data.references[0])
  assert.equal(read.isError,true,'直接把整行资料传入必须拒绝多余字段')
  const ref=data.references[0]!
  const success=await execute(names[1]!,{id:ref.id,version:ref.version})
  assert.equal(success.isError,false)
  assert.ok(success.content.some(item=>item.type==='text'&&item.text.includes('Teloa')))
  const conflict=await execute(names[1]!,{id:ref.id,version:'0'.repeat(64)})
  assert.equal(conflict.isError,true)
  assert.ok(conflict.content.some(item=>item.type==='text'&&item.text.includes('reference/version-conflict')))
  await fiber.dispose()
  assert.deepEqual(ctx.tools.schemas(),[])
  assert.deepEqual((await ctx.systemPrompt.assemble()).tools,[])
  assert.equal((await execute(names[0]!,{})).isError,true)
})
