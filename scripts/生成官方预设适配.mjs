import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'

// 官方预设的 plugins 是整表替换；从当前锁定依赖生成，避免手工维护第二份官方实现。
const require=createRequire(new URL('../packages/harness-dsh/package.json',import.meta.url))
const officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const {parse,stringify}=require('yaml')
const officialRoot=dirname(officialRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
const manifest=JSON.parse(await readFile(join(officialRoot,'package.json'),'utf8'))
if(manifest.version!=='0.2.1-alpha.1')throw Error('请先复核新的官方预设版本，再更新适配与安全摘要。')
const customTags=[{tag:'tag:yaml.org,2002:js',identify:value=>typeof value?.__jsExpr==='string',resolve:value=>({__jsExpr:value}),stringify:item=>JSON.stringify(item.value.__jsExpr)}]
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
 const visit=rows=>{for(const row of rows){if(row.id==='workflow-ptc')workflows.push(row);if(row.id==='compaction-basic')compactions.push(row);if(row.group===true)visit(row.config)}}
 visit(declaration.config.plugins)
 if(id==='standard'){
  if(workflows.length!==1||workflows[0].name!=='@deepseek-ai/dsh-workflow-ptc'||workflows[0].config?.provider!=='spawn')throw Error('官方 workflow 派发配置已变化。')
  workflows[0].config.provider='teloa-workflow-spawn'
 }
 if(compactions.length!==1||compactions[0].name!=='@deepseek-ai/dsh-compaction-basic')throw Error('官方 '+id+' 压缩配置已变化。')
 compactions[0].name='@teloa/harness-dsh/local-compaction'
 const content='# 自动生成自 DSH 0.2.1-alpha.1；请运行 node scripts/生成官方预设适配.mjs，勿手改。\n'
  +stringify([{id:declaration.id,config:declaration.config}],{customTags,lineWidth:0})
 const target=new URL('../packages/bundle/agent-presets/'+id+'.patch.yml',import.meta.url)
 if(process.argv.includes('--check')){
  if(await readFile(target,'utf8')!==content)throw Error('官方 '+id+' 适配已过期，请重新生成并复核安全摘要。')
  console.log('官方 '+id+' 预设适配与锁定依赖一致。')
 }else{
  await writeFile(target,content)
  console.log('已生成 '+fileURLToPath(target))
 }
}
