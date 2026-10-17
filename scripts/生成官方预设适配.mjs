import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {presetBodyNormalizedDigest} from '../packages/harness-dsh/src/composition-safety.ts'

// 官方预设的 plugins 是整表替换；从当前锁定依赖生成，避免手工维护第二份官方实现。
const require=createRequire(new URL('../packages/harness-dsh/package.json',import.meta.url))
const officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const {parse,stringify}=require('yaml')
const officialRoot=dirname(officialRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
const manifest=JSON.parse(await readFile(join(officialRoot,'package.json'),'utf8'))
if(manifest.version!=='0.2.1-rc.2')throw Error('请先复核新的官方预设版本，再更新适配与安全摘要。')
const customTags=[{tag:'tag:yaml.org,2002:js',identify:value=>typeof value?.__jsExpr==='string',resolve:value=>({__jsExpr:value}),stringify:item=>JSON.stringify(item.value.__jsExpr)}]
const derivedDigests={}
for(const id of ['standard','ptc','cordis']){
 const source=parse(await readFile(join(officialRoot,'presets',id+'.patch.yml'),'utf8'),{customTags})
 const declaration=source[0]?.insert?.[0]
 if(source.length!==1||source[0].insert.length!==1||declaration.id!=='preset-'+id||declaration.name!=='@deepseek-ai/dsh-agent-preset'||declaration.config.id!==id)throw Error('官方 '+id+' 声明形状已变化。')
 // Schedule 服务保留旧提醒；模型写入口由 Teloa 业务计划承载，基础 Agent 不能借原生工具绕过权益。
 const removeScheduleTools=rows=>rows.filter(row=>row.id!=='tool-schedule'&&row.name!=='@deepseek-ai/dsh-tool-schedule').map(row=>{
  if(row.group===true&&Array.isArray(row.config))row.config=removeScheduleTools(row.config)
  return row
 })
 declaration.config.plugins=removeScheduleTools(declaration.config.plugins)
 const workflows=[],compactions=[]
 const visit=rows=>{for(const row of rows){if(row.id==='workflow-ptc')workflows.push(row);if(row.id==='compaction-basic')compactions.push(row);if(row.id==='tool-jobs'){if(row.name!=='@deepseek-ai/dsh-tool-jobs')throw Error('官方后台工具配置已变化。');row.name='@teloa/harness-dsh/managed-tool-jobs'}if(row.group===true)visit(row.config)}}
 visit(declaration.config.plugins)
 // 官方 0.2.1-rc.2 的 dsh-agent-tool-presentation 在 ptc/both 下于 ctx.inject(['ptcRuntime']) 子上下文调用 tools.presentAs，
 // 而 presentAs 还要注册 systemPrompt 段；子上下文只继承本行声明的依赖（插件只声明了 tools），严格注入拒绝 systemPrompt，
 // 呈现声明随即回滚，预设看似生效、模型实际仍拿到 native 工具面。用加载器公开的行级 inject 补上依赖，不改官方实现、不改部署默认。
 for(const row of declaration.config.plugins){
  if(row.id!=='tool-presentation')continue
  if(row.name!=='@deepseek-ai/dsh-agent-tool-presentation'||row.inject!==undefined)throw Error('官方工具呈现行配置已变化。')
  if(row.config?.mode==='ptc'||row.config?.mode==='both')row.inject=['systemPrompt']
 }
 if(id==='standard'){
  // 原 id 保留给既有会话；新工作的增强默认项统一叫“标准模式”，避免两个同名入口。
  declaration.config.name='DSH 原生标准模式'
  declaration.config.description='DSH 原生工具与提示词组合。'
  if(workflows.length!==1||workflows[0].name!=='@deepseek-ai/dsh-workflow-ptc'||workflows[0].config?.provider!=='spawn')throw Error('官方 workflow 派发配置已变化。')
  workflows[0].config.provider='teloa-workflow-spawn'
 }
 if(compactions.length!==1||compactions[0].name!=='@deepseek-ai/dsh-compaction-basic')throw Error('官方 '+id+' 压缩配置已变化。')
 compactions[0].name='@teloa/harness-dsh/local-compaction'
 const variants=[{id,rows:[{id:declaration.id,config:declaration.config}]}]
 if(id==='ptc')for(const variant of ['ptc-persistent','ptc-python']){
  const runtime={id:'selected-ptc-runtime',name:variant==='ptc-python'?'@deepseek-ai/dsh-experimental-ptc-runtime-python':'@deepseek-ai/dsh-ptc-runtime-node',...(variant==='ptc-persistent'?{config:{executionMode:'persistent-in-memory'}}:{})}
  const plugins=structuredClone(declaration.config.plugins)
  plugins.unshift({id:'selected-code-runtime',name:'cordis:group',group:true,isolate:{ptcRuntime:true},config:[runtime,{id:'bind-code-runtime',name:'@teloa/harness-dsh/native-ptc-selection'}]})
  const description=variant==='ptc-persistent'?'Keep variables in this session memory; restarting the app clears them.':'Run Python code with the current file permissions and approval rules.'
  variants.push({id:variant,rows:[{insert:[{id:'preset-'+variant,name:'@deepseek-ai/dsh-agent-preset',disabled:false,config:{...declaration.config,id:variant,description,order:variant==='ptc-persistent'?2.1:2.2,plugins}}]}]})
  derivedDigests[variant]=presetBodyNormalizedDigest(plugins)
 }
 for(const variant of variants){
 const content='# 自动生成自 DSH 0.2.1-rc.2；请运行 node scripts/生成官方预设适配.mjs，勿手改。\n'
  +stringify(variant.rows,{customTags,lineWidth:0})
 const target=new URL('../packages/bundle/agent-presets/'+variant.id+'.patch.yml',import.meta.url)
 if(process.argv.includes('--check')){
  if(await readFile(target,'utf8')!==content)throw Error('官方 '+id+' 适配已过期，请重新生成并复核安全摘要。')
  console.log('官方 '+id+' 预设适配与锁定依赖一致。')
 }else{
  await writeFile(target,content)
  console.log('已生成 '+fileURLToPath(target))
 }
 }
}
const digestTarget=new URL('../packages/harness-dsh/src/generated-ptc-preset-digests.ts',import.meta.url)
const digestContent='// 自动生成；来源与预设正文同 scripts/生成官方预设适配.mjs。\nexport const derivedPtcPresetBodyDigests='+JSON.stringify(derivedDigests,null,1)+' as const\n'
if(process.argv.includes('--check')){if(await readFile(digestTarget,'utf8')!==digestContent)throw Error('可选代码预设安全摘要已过期。')}
else await writeFile(digestTarget,digestContent)
