import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectIndustryContent } from '../src/client/industry-content.ts'
import { readIndustryDirectory, type IndustryContent } from '../src/client/industry-directory.ts'
import { validateIndustryManifest } from '../src/client/industry-manifest.ts'
const file=(path:string,text:string)=>{const bytes=new TextEncoder().encode(text);return {path,size:bytes.length,read:async()=>bytes}}
const content=(files:readonly (readonly [string,unknown])[]):IndustryContent=>({manifestPath:'teloa.json',hash:'0'.repeat(64),resources:[],files:files.map(([path,value])=>({path,hash:'0'.repeat(64),bytes:new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value))}))})
const manifest={format:'teloa.business-package/v2',id:'demo',title:'通用研究',version:'1.0.0',domain:'general',description:'研究',resources:[{id:'role',kind:'role',title:'研究岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},{id:'knowledge',kind:'knowledge',title:'手册',version:'1.0.0',required:true,source:{kind:'local',path:'guide.md'}}],relations:[{kind:'role-knowledge',from:'role',to:'knowledge'}],entrypoints:[]}
const role={format:'teloa.role/v1',name:'研究岗',kind:'employee',duty:'核对来源',dataScope:'提供的资料',executionScope:'代拟与查询'}
const inspect=async(roleText:string,knowledge='# 手册\n核对原文')=>{
 const item=await readIndustryDirectory([file('root/teloa.json',JSON.stringify(manifest)),file('root/role.json',roleText),file('root/guide.md',knowledge)],'root/teloa.json','demo')
 assert.ok(item.manifest?.format==='teloa.business-package/v2'&&item.packageContent)
 return inspectIndustryContent(item.manifest,item.packageContent)
}
test('解析岗位与知识原文，保留角色与清单关系的独立身份',async()=>{
 const rows=await inspect(JSON.stringify(role))
 assert.equal(rows[0]?.state,'parsed');assert.equal(rows[1]?.state,'parsed')
 assert.equal(rows[0]?.definition?.kind,'role')
 if(rows[0]?.definition?.kind==='role')assert.equal(rows[0].definition.fields.duty,'核对来源')
 if(rows[1]?.definition?.kind==='knowledge')assert.equal(rows[1].definition.text,'# 手册\n核对原文')
})
test('单个非法岗位留下明确错误，不损失同集合中的有效知识',async()=>{
 for(const value of [{...role,kind:'admin'},{...role,duty:''},{...role,scopes:['all']},{...role,format:'unknown'}]){
  const rows=await inspect(JSON.stringify(value));assert.equal(rows[0]?.state,'invalid');assert.ok(rows[0]?.message);assert.equal(rows[1]?.state,'parsed')
 }
 const rows=await inspect('{bad');assert.equal(rows[0]?.state,'invalid')
})
test('空知识内容拒绝，正文中的HTML作为纯文本保留',async()=>{
 assert.equal((await inspect(JSON.stringify(role),'   '))[1]?.state,'invalid')
 const row=(await inspect(JSON.stringify(role),'<script>alert(1)</script>'))[1]
 assert.equal(row?.state,'parsed')
 if(row?.definition?.kind==='knowledge')assert.equal(row.definition.text,'<script>alert(1)</script>')
})
test('行业工作模板复用市场规范，固定版本，不把格式或版本错误当作可用入口',async()=>{
 const definition={format:'teloa.work-template/v1',id:'review',title:'资料核对',version:'1.0.0',domain:'general',description:'逐条核对来源',requirements:['提供资料'],output:'核对报告',skills:[]}
 for(const version of ['1.0.0','2.0.0']){
  const raw={...manifest,resources:[{...manifest.resources[0]!,id:'work',kind:'work-template',source:{kind:'local',path:'work.json'}}],relations:[],entrypoints:['work']}
  const item=await readIndustryDirectory([file('teloa.json',JSON.stringify(raw)),file('work.json',JSON.stringify({...definition,version}))],'teloa.json','工作模板')
  assert.ok(item.manifest?.format==='teloa.business-package/v2'&&item.packageContent)
  const row=inspectIndustryContent(item.manifest,item.packageContent)[0]
  assert.equal(row?.state,version==='1.0.0'?'parsed':'invalid')
  if(row?.definition?.kind==='work-template')assert.deepEqual(row.definition.manifest.requirements,['提供资料'])
 }
})
test('Skill原文可预览但仍待宿主核验，目录附件不混入其他Skill',async()=>{
 const raw={...manifest,resources:[{id:'skill',kind:'skill',title:'研究技能',version:'1.0.0',required:true,source:{kind:'local',path:'skills/research/SKILL.md'}}],relations:[],entrypoints:['skill']}
 const text='---\nname: research\ndescription: 核对资料\n---\n\n<script>not executed</script>'
 const item=await readIndustryDirectory([file('root/teloa.json',JSON.stringify(raw)),file('root/skills/research/SKILL.md',text),file('root/skills/research/references/guide.md','附件'),file('root/skills/other/SKILL.md','其他技能')],'root/teloa.json','模板')
 assert.ok(item.manifest?.format==='teloa.business-package/v2'&&item.packageContent)
 const row=inspectIndustryContent(item.manifest,item.packageContent)[0]
 assert.equal(row?.state,'pending')
 assert.equal(row?.definition?.kind,'skill')
 assert.ok(row?.definition?.kind==='skill')
 const definition=row.definition
 assert.equal(definition.text,text)
 assert.deepEqual(definition.files.map(value=>value.path),['SKILL.md','references/guide.md'])
})
test('数据源、MCP 连接与插件定义按格式解析，非法定义显示 invalid',()=>{
 const connected=validateIndustryManifest({format:'teloa.business-package/v2',id:'t',title:'T',version:'1.0.0',domain:'SOC',description:'d',resources:[
  {id:'ds',kind:'data-source',title:'告警',version:'1.0.0',required:true,source:{kind:'local',path:'data/alerts.json'}},
  {id:'mcp',kind:'mcp',title:'连接',version:'1.0.0',required:true,source:{kind:'local',path:'connections/alerts.json'}},
  {id:'pl',kind:'plugin',title:'插件',version:'0.1.2',required:false,source:{kind:'local',path:'plugins/visualize.json'}},
  {id:'tool',kind:'execution-tool',title:'处置',version:'1.0.0',required:false,source:{kind:'local',path:'tools/isolate.json'}},
 ],relations:[],entrypoints:[]})
 const dataSource={format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC']}
 const connection={format:'teloa.mcp-connection/v1',serverName:'teloa_reference',tools:['read_reference']}
 const plugin={format:'teloa.plugin/v1',registry:'npm',packageName:'dsh-visualize',version:'0.1.2'}
 const tool={format:'teloa.execution-tool/v1',adapterId:'security-action-http',tools:['security.endpoint.isolate']}
 const rows=inspectIndustryContent(connected,content([['data/alerts.json',dataSource],['connections/alerts.json',connection],['plugins/visualize.json',plugin],['tools/isolate.json',tool]]))
 assert.deepEqual(rows.map(row=>row.state),['parsed','parsed','parsed','pending'])
 assert.equal(rows[2]!.definition?.kind,'plugin')
 assert.ok(rows[0]!.definition?.kind==='data-source'&&rows[0]!.definition.definition.sourceId==='security-alert-http')
 assert.ok(rows[1]!.definition?.kind==='mcp'&&rows[1]!.definition.definition.serverName==='teloa_reference')
 const bad=inspectIndustryContent(connected,content([['data/alerts.json','{"format":"x"}']]))
 assert.equal(bad[0]!.state,'invalid')
 assert.deepEqual(bad.slice(1).map(row=>row.state),['missing','missing','missing'])
 const mismatch=inspectIndustryContent(connected,content([['plugins/visualize.json',{...plugin,version:'0.1.3'}]]))
 assert.equal(mismatch[2]!.state,'invalid')
})
