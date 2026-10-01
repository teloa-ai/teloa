import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import {businessWidgetKinds,readBusinessDashboardDefinition,readBusinessSourceMappingDefinition,readBusinessWidgetDefinition} from '@teloa/contract'
import {officialCatalogBuiltin} from '@teloa/backend'
import {builtinSkillCreatorName,prepareBuiltinSkill,prepareBuiltinSkillCreator,registerBuiltinSkill,type BuiltinSkillCreatorPorts} from '../src/builtin-skill-creator.ts'
import {builtinDashboardDesignerName} from '../src/builtin-dashboard-designer.ts'

const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem}
const skillRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh-skill'))
const {createScope}=await import(pathToFileURL(skillRequire.resolve('@deepseek-ai/dsh-scope')).href) as {createScope:(ctx:Context,key:object)=>{ctx:Context;dispose:()=>Promise<void>}}

async function setup(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-builtin-dashboard-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:root})
 await ctx.plugin(ToolSkill)
 const agent=(id:string)=>{const target={} as Agent,scope=createScope(ctx,target);Object.assign(target,{ctx:scope.ctx,session:{id,header:{cwd:root},surface:{nodes:[]},events:[]}});return target}
 return {ctx,root,agent}
}
const ports=(policy:(id:string)=>unknown=()=>null):BuiltinSkillCreatorPorts=>({owner:'owner',conversation:async id=>({ownerId:'owner',sessionId:id,status:'ready'}),readTaskPolicy:async id=>policy(id) as never})
const step=(ctx:Context,agent:Agent,text:string)=>{const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})];return ctx.waterfall('agent/pre-step',{agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages}))}
const skillText=()=>new TextDecoder().decode(officialCatalogBuiltin(builtinDashboardDesignerName).files.find(file=>file.path==='SKILL.md')!.bytes)

test('官方目录可取「看板设计」内置条目：含 SKILL.md，frontmatter name 一致',()=>{
 assert.equal(builtinDashboardDesignerName,'teloa-dashboard-designer')
 const builtin=officialCatalogBuiltin(builtinDashboardDesignerName)
 assert.equal(builtin.entry.id,'teloa.dashboard-designer')
 assert.equal(builtin.entry.version,'1.1.0')
 assert.deepEqual(builtin.files.map(file=>file.path).sort(),['LICENSE','SKILL.md'])
 assert.ok(skillText().startsWith('---\nname: teloa-dashboard-designer\n'))
})

test('通用 prepareBuiltinSkill 对技能创建器的输出与原导出逐字段相同',async t=>{
 const {ctx,root}=await setup(t)
 const builtin=officialCatalogBuiltin(builtinSkillCreatorName)
 const creator=await prepareBuiltinSkillCreator(ctx,{runtimeRoot:root,treeHash:builtin.treeHash,files:builtin.files})
 const generic=await prepareBuiltinSkill(ctx,{name:builtinSkillCreatorName,runtimeRoot:root,treeHash:builtin.treeHash,files:builtin.files})
 assert.deepEqual(generic,creator)
 assert.equal(generic.rendered,creator.rendered)
 await assert.rejects(prepareBuiltinSkill(ctx,{name:builtinDashboardDesignerName,runtimeRoot:root,treeHash:builtin.treeHash,files:builtin.files}),{code:'teloa/dependency-unavailable'},'名字与字节不符即拒绝')
})

test('注册后本人普通会话 agent 层可见（provider teloa-builtin），任务会话与 global 层不可见',async t=>{
 const {ctx,root,agent}=await setup(t)
 const builtin=officialCatalogBuiltin(builtinDashboardDesignerName)
 const skill=await prepareBuiltinSkill(ctx,{name:builtinDashboardDesignerName,runtimeRoot:root,treeHash:builtin.treeHash,files:builtin.files})
 assert.equal(skill.definition.name,builtinDashboardDesignerName);assert.equal(skill.definition.provider,'teloa-builtin')
 registerBuiltinSkill(ctx,skill,ports(id=>id==='task-session'?{allowedTools:[]}:null))
 const ordinary=agent('ordinary-session'),task=agent('task-session')
 await step(ctx,ordinary,'给我做个告警趋势看板');await step(ctx,task,'给我做个告警趋势看板')
 const visible=(await ctx.skills.list({scope:ordinary})).find(item=>item.name===builtinDashboardDesignerName)
 assert.equal(visible?.provider,'teloa-builtin')
 assert.ok(!(await ctx.skills.list({scope:task})).some(item=>item.name===builtinDashboardDesignerName))
 assert.ok(!(await ctx.skills.list()).some(item=>item.name===builtinDashboardDesignerName))
})

test('SKILL.md 正文：三个工具名、组件种类、interval 示例、表名换算与不得编造字段；不含凭据与本机路径',()=>{
 const text=skillText()
 for(const name of ['teloa_business_definitions_directory','teloa_business_sql_trial','teloa_business_definitions_draft'])assert.ok(text.includes(name),name)
 for(const kind of businessWidgetKinds)assert.ok(text.includes('`'+kind+'`'),kind)
 assert.ok(text.includes("interval '7 days'"))
 assert.ok(text.includes('表名 `-`→`_`'))
 assert.ok(text.includes('不得编造字段'))
 assert.ok(text.includes('业务 → 看板 → 待确认'))
 assert.doesNotMatch(text,/\/Users\/|\/home\/|[A-Za-z]:\\|~\/|\bsk-[A-Za-z0-9]{8,}|api[_-]?key|password|secret|token=|Bearer /i)
})

/** 正文里的 JSON 示例逐个过契约读取器：按 `format` 选组件 / 看板 / 数据源映射读取器，读不过即失败。 */
const jsonExamples=(text:string)=>[...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match=>JSON.parse(match[1]!) as Record<string,any>)
const readers:Record<string,(value:unknown)=>unknown>={
 'teloa.business-widget/v1':readBusinessWidgetDefinition,
 'teloa.business-dashboard/v1':readBusinessDashboardDefinition,
 'teloa.business-source-mapping/v1':readBusinessSourceMappingDefinition,
}

test('1.1.0 正文教时间范围、下钻与 MCP 分页；不再说一期不支持；时间轴不写 axis.format；预览对不上按原因改',()=>{
 const text=skillText()
 for(const word of ['filters','timeRange','timeFilter','drilldown','idColumn','match','pagination','cursorArgument','nextCursorPath'])assert.ok(text.includes('`'+word+'`'),word)
 assert.ok(!text.includes('一期不支持'))
 assert.ok(!text.includes('不支持看板 `filters`'))
 assert.ok(!text.includes('一期不分页'))
 assert.match(text,/时间轴不写 `axis\.format`/)
 assert.ok(text.includes('草案与已有定义对不上'))
})

test('1.1.0 正文的 JSON 示例全部过契约读取器，并覆盖五种新写法',()=>{
 const examples=jsonExamples(skillText())
 for(const example of examples){
  const read=readers[example.format]
  assert.ok(read,'示例 format 不认识：'+example.format)
  assert.doesNotThrow(()=>read(example),'示例读不过：'+example.id)
 }
 const widgets=examples.filter(item=>item.format==='teloa.business-widget/v1')
 assert.ok(examples.some(item=>item.format==='teloa.business-dashboard/v1'&&item.filters?.timeRange),'带 filters 的看板')
 assert.ok(widgets.some(item=>item.kind==='chart'&&item.timeFilter&&item.chart.spec.encoding.x.type==='temporal'&&item.chart.spec.encoding.x.axis?.format===undefined),'带 timeFilter 的趋势图，时间轴不写 format')
 assert.ok(widgets.some(item=>item.kind==='chart'&&item.chart.spec.mark==='bar'&&item.drilldown?.match),'match 下钻柱状图')
 assert.ok(widgets.some(item=>item.kind==='table'&&item.drilldown?.idColumn),'idColumn 下钻表格')
 assert.ok(examples.some(item=>item.format==='teloa.business-source-mapping/v1'&&item.source.kind==='mcp-tool'&&item.source.pagination),'带 pagination 的 mcp-tool 映射')
 // 看板引用的组件都在示例里，接入范围的组件至少一个（范围级核对的最小形状）。
 for(const board of examples.filter(item=>item.format==='teloa.business-dashboard/v1'&&item.filters)){
  const used=widgets.filter(item=>board.widgets.includes(item.id))
  assert.equal(used.length,board.widgets.length,board.id+' 引用的组件都有示例')
  assert.ok(used.some(item=>item.timeFilter),board.id+' 至少一个组件接入时间范围')
 }
})
