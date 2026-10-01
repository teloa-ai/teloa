import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseMarketManifest, githubSource, emptyMarket, sandboxMarket, importManifest, itemFromManifest, saveMarketIntent, updateMarketIntent, filterMarket, createTeamTemplate, marketTrustPreview, localizedMarketItemMetadata } from '../src/client/market-preview.ts'
import { validateIndustryManifest } from '../src/client/industry-manifest.ts'
import { PromptPreparation } from '../src/client/prompt-preparation.ts'

const manifest={format:'teloa.business-package/v1',id:'demo-kit',title:'研究资源包',version:'1.0.0',domain:'general',description:'整理来源',requirements:['获准资料'],output:'可审阅报告',components:[{kind:'skill',path:'skills/research/SKILL.md',required:true}]}
const now='2026-09-11T03:00:00Z'
test('正式市场初始目录为空，演示资源只能从独立沙盒显式取得',()=>{
 assert.deepEqual(emptyMarket(),{items:[],intents:[]})
 const sandbox=sandboxMarket()
 assert.ok(sandbox.items.length>0)
 assert.ok(sandbox.items.every(item=>item.source.kind==='builtin'))
})
test('正式工作台只初始化正式市场，不引用沙盒目录',async()=>{
 const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(source,/useState\(emptyMarket\)/)
 assert.doesNotMatch(source,/\bsandboxMarket\b/)
})
test('三个内置行业模板提供未安装的 v2 资源分类声明',()=>{
 const bundles=['bundle-general','bundle-security','bundle-design'].map(id=>sandboxMarket().items.find(item=>item.id===id)!)
 assert.equal(bundles.length,3)
 for(const item of bundles){
  assert.equal(item.manifest?.format,'teloa.business-package/v2')
  assert.equal(item.hash,undefined)
  assert.equal(item.packageContent,undefined)
  assert.match(item.compatibility,/待验证|未读取/)
  const manifest=validateIndustryManifest(item.manifest)
  // 第三方插件 dsh-visualize 已整体下线（产品底座只用官方插件），三份内置清单都不再带 plugin 资源。
  assert.deepEqual(new Set(manifest.resources.map(resource=>resource.kind)),new Set(['role','knowledge','skill','mcp','data-source','execution-tool','work-template','plan']))
  assert.ok(manifest.relations.length>0)
  assert.ok(manifest.entrypoints.length>0)
 }
 const security=validateIndustryManifest(bundles[1]!.manifest)
  assert.deepEqual(new Set(security.resources.map(resource=>resource.kind)),new Set(['role','knowledge','skill','mcp','data-source','execution-tool','work-template','plan']))
  assert.deepEqual(security.resources.filter(resource=>resource.kind==='role').map(resource=>resource.id),['security-investigator-role','security-appsec-auditor-role'])
  const securitySkills=security.relations.filter(relation=>relation.kind==='role-skill').map(relation=>[relation.from,relation.to])
  assert.ok(securitySkills.some(relation=>relation[0]==='security-investigator-role'&&relation[1]==='security-investigation-skill'))
  assert.ok(securitySkills.some(relation=>relation[0]==='security-appsec-auditor-role'&&relation[1]==='security-code-audit-skill'))
  const general=validateIndustryManifest(bundles[0]!.manifest)
  for(const manifest of [general,security]){
   assert.deepEqual(manifest.resources.find(resource=>resource.id.endsWith('report-skill'))?.source,{kind:'public',id:'skill-report',version:'0.1.0'})
   for(const resource of manifest.resources.filter(resource=>resource.kind==='mcp'))assert.deepEqual(resource.source,{kind:'public',id:'resource-mcp',version:'0.1.0'})
  }
})
test('内置公共市场资源至少提供简体中文和英文目录元数据',()=>{
 const publicItems=sandboxMarket().items.filter(item=>item.visibility==='public')
 assert.ok(publicItems.length>0)
 for(const item of publicItems){
  assert.equal(typeof item.localized?.title?.locales['zh-CN'],'string',item.id+' zh-CN title')
  assert.equal(typeof item.localized?.title?.locales.en,'string',item.id+' en title')
  assert.equal(typeof item.localized?.summary?.locales['zh-CN'],'string',item.id+' zh-CN summary')
  assert.equal(typeof item.localized?.summary?.locales.en,'string',item.id+' en summary')
  const english=localizedMarketItemMetadata(item,'en')
  assert.doesNotMatch(english.title.value,/\p{Script=Han}/u,item.id+' en title')
  assert.doesNotMatch(english.summary.value,/\p{Script=Han}/u,item.id+' en summary')
 }
})
test('清单真实解析及内容摘要：同一原文去重，同名异内容不覆盖',async()=>{
  const parsed=await parseMarketManifest(JSON.stringify(manifest))
  assert.match(parsed.hash,/^[a-f0-9]{64}$/)
  assert.equal((await parseMarketManifest(JSON.stringify(manifest))).hash,parsed.hash)
  let state=importManifest(sandboxMarket(),parsed,{kind:'paste'},now)
  state=importManifest(state,parsed,{kind:'upload',name:'package.json',size:100},now)
  assert.equal(state.items.filter(item=>item.hash===parsed.hash).length,1)
  const different=await parseMarketManifest(JSON.stringify({...manifest,description:'核对新来源'}))
  state=importManifest(state,different,{kind:'paste'},now)
  assert.notEqual(different.hash,parsed.hash)
  assert.equal(state.items.filter(item=>item.title===manifest.title).length,2)
  assert.equal(state.items.find(item=>item.hash===parsed.hash)?.visibility,'personal')
})
test('市场清单保留稳定元数据并按 locale 解析标题和摘要',async()=>{
 const localized={
  title:{original:'研究资源包',defaultLocale:'en',locales:{en:'Research package','pt':'Pacote de pesquisa'}},
  description:{original:'整理来源',defaultLocale:'en',locales:{en:'Organize sources','zh-Hant':'整理來源'}},
 }
 const parsed=await parseMarketManifest(JSON.stringify({...manifest,localized}))
 const item=itemFromManifest(parsed,{kind:'paste'})
 assert.equal(item.title,'研究资源包');assert.equal(item.summary,'整理来源')
 assert.deepEqual(localizedMarketItemMetadata(item,'pt-BR'),{
  title:{value:'Pacote de pesquisa',locale:'pt'},summary:{value:'Organize sources',locale:'en'},
 })
 assert.throws(()=>localizedMarketItemMetadata(item,'not_a_locale'),/locale/)
})
test('本地清单摘要与固定 UTF-8 文件内容一致，而非对重排字段后的对象取摘要',async()=>{
  const raw=await readFile(new URL('../../../../tests/fixtures/市场清单验收.json',import.meta.url),'utf8')
  const parsed=await parseMarketManifest(raw)
  assert.equal(parsed.raw,raw)
  assert.equal(parsed.hash,'e61c0e77a06867d05ac3b8a573a66200f845f17893e94fb75b587905e03b59fe')
})
test('未知字段、越界组件、超限与损坏清单明确拒绝，不运行组件',async()=>{
  for(const path of ['../file','/root/file','a\\b','a/%2e%2e/file','a//b'])await assert.rejects(()=>parseMarketManifest(JSON.stringify({...manifest,components:[{kind:'skill',path,required:true}]})),/路径/)
  await assert.rejects(()=>parseMarketManifest(JSON.stringify({...manifest,apiKey:'credential'})),/未知字段/)
  await assert.rejects(()=>parseMarketManifest('{bad'),/JSON/)
  await assert.rejects(()=>parseMarketManifest('x'.repeat(1024*1024+1)),/1 MiB/)
  await assert.rejects(()=>parseMarketManifest(JSON.stringify({...manifest,components:[{kind:'unknown',path:'x',required:true}]})),/组件/)
})
test('GitHub 来源不会被标成已下载，不能夹带认证、查询参数或其他站点',()=>{
  assert.deepEqual(githubSource('https://github.com/example/project','main'),{kind:'github',url:'https://github.com/example/project',revision:'main'})
  for(const url of ['https://user:pass@github.com/example/repo','http://github.com/example/repo','https://example.com/repo','https://github.com/example/repo?token=secret'])assert.throws(()=>githubSource(url,''),/GitHub/)
})
test('来源信任预览区分未验证与无效签名，并列出独立插件、MCP 和权限',()=>{
 const item={...sandboxMarket().items.find(value=>value.id==='skill-report')!,trust:{publisher:'Teloa Labs',repository:{host:'github.com' as const,owner:'teloa-ai',repo:'skills'},license:{status:'missing' as const},signature:{status:'unverified' as const,signer:null},compatibility:{teloa:'>=0.0.1 <1.0.0',dsh:'>=0.1.2-alpha.3 <0.2.0'},plugins:[{id:'writer-ui',version:'1.0.0',required:false}],externalCapabilities:[{id:'docs',kind:'mcp' as const,required:true}],permissions:[{id:'docs.read',description:'读取已授权资料',required:true}],review:{conclusion:'needs-review' as const,summary:'签名尚未验证'}}}
 assert.deepEqual(marketTrustPreview(item),{publisher:'Teloa Labs · github.com/teloa-ai/skills',license:'未注明许可证',signature:'未验证',compatibility:'Teloa >=0.0.1 <1.0.0 · DSH >=0.1.2-alpha.3 <0.2.0',review:'待审查 · 签名尚未验证',skills:['报告撰写 @0.1.0'],plugins:['writer-ui @1.0.0（可选）'],connections:['MCP · docs（必需）'],permissions:['docs.read · 读取已授权资料（必需）'],installable:true})
 assert.equal(marketTrustPreview({...item,trust:{...item.trust,signature:{status:'invalid',signer:null}}}).installable,false)
})
test('插件详情列出插件自身携带的 Skill',()=>{
 // 第三方插件 dsh-visualize 已整体下线，这里用任意既有条目换一份 components 验证同一条通用机制：
 // marketTrustPreview 按名字里带「Skill」的组件挑出插件自带的 Skill，不专属某一个具体插件。
 const item={...sandboxMarket().items.find(value=>value.id==='resource-mcp')!,components:[{name:'visualize Skill',required:true,status:'来源仓库组件，尚未安装'},{name:'visualize Tool',required:true,status:'来源仓库组件，尚未安装'}]}
 assert.deepEqual(marketTrustPreview(item).skills,['visualize Skill'])
})
test('安装意图共用身份；范围、目标或内容不同不能复用，编辑校验版本且不出现已安装',()=>{
  const state=sandboxMarket(),item=state.items.find(item=>item.id==='bundle-security')!
  const input={id:'intent-1',itemId:item.id,scope:'SOC',target:'业务空间 SOC',purpose:'接入安全岗位',visibility:'personal' as const,now}
  let next=saveMarketIntent(state,input)
  assert.equal(saveMarketIntent(next,{...input,id:'intent-2'}).intents.length,1)
  next=saveMarketIntent(next,{...input,id:'intent-3',target:'另一团队'})
  assert.equal(next.intents.length,2)
  assert.throws(()=>updateMarketIntent(next,{id:'intent-1',expectedVersion:99,purpose:'修改',visibility:'team',action:'edit',now}),/版本/)
  next=updateMarketIntent(next,{id:'intent-1',expectedVersion:1,purpose:'修改',visibility:'team',action:'edit',now})
  assert.equal(next.intents[0]?.status,'draft')
  assert.equal(next.intents[0]?.version,2)
  assert.equal(next.intents[0]?.itemVersion,item.version)
  next=updateMarketIntent(next,{id:'intent-1',expectedVersion:2,purpose:'修改',visibility:'team',action:'withdraw',now})
  assert.equal(next.intents[0]?.status,'withdrawn')
})
test('公共与通用可分别筛选；保存工作模板只接受白名单内容，不公开或复制资料',async()=>{
  const state=sandboxMarket()
  assert.ok(filterMarket(state.items,{kind:'skill',scope:'general',visibility:'public',query:''}).length)
  const item=await createTeamTemplate({id:'my-template',title:'泛化研究',domain:'general',description:'核对来源',requirements:['获准资料'],output:'报告',visibility:'personal'})
  assert.equal(item.visibility,'personal')
  assert.ok(!item.raw?.includes('credentials'))
  await assert.rejects(()=>createTeamTemplate({id:'t',title:'x',domain:'general',description:'x',requirements:['x'],output:'x',visibility:'public'}),/本人|团队/)
})
test('会话准备冻结文本与目标：其他会话、已有草稿、撤回均不能插入；不自动发送',()=>{
  const queue=new PromptPreparation();const writes:string[]=[]
  queue.prepare({id:'p1',sourceId:'intent-1',sourceVersion:1,sessionId:'s1',title:'研究草案',text:'请先代拟，不安装。'})
  assert.throws(()=>queue.insert('p1','s2',{draft:'',attachmentIds:[],phase:'plain'},false,{setDraft:text=>writes.push(text)}),/会话/)
  assert.throws(()=>queue.insert('p1','s1',{draft:'原草稿',attachmentIds:[],phase:'plain'},false,{setDraft:text=>writes.push(text)}),/草稿/)
  queue.insert('p1','s1',{draft:'',attachmentIds:[],phase:'plain'},false,{setDraft:text=>writes.push(text)})
  assert.deepEqual(writes,['请先代拟，不安装。'])
  assert.equal(queue.getSnapshot()[0]?.status,'inserted')
  assert.throws(()=>queue.insert('p1','s1',{draft:'',attachmentIds:[],phase:'plain'},false,{setDraft:text=>writes.push(text)}),/状态/)
  queue.prepare({id:'p2',sourceId:'intent-1',sourceVersion:2,sessionId:'s1',title:'研究草案',text:'新版本'})
  queue.invalidate('intent-1')
  assert.equal(queue.getSnapshot()[1]?.status,'stale')
})

test('官方目录审核说明：存储原文进 trustHash 不改，展示时把旧说法换成白话（上游 → 原作者、机器固定收录 → 自动收录、核验摘要 → 核验校验值）',()=>{
 const base=sandboxMarket().items.find(value=>value.id==='skill-report')!
 const trust=(summary:string)=>({publisher:'Teloa 官方目录',repository:null,license:{status:'declared' as const,value:'MIT'},signature:{status:'unverified' as const,signer:null},compatibility:{teloa:'*',dsh:'*'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'approved' as const,summary}})
 const upstream=marketTrustPreview({...base,trust:trust('Teloa 官方目录收录（资源 a.b@1.0.0）；上游 Acme，许可 MIT；兼容状态 compatible')}).review
 assert.equal(upstream,'已审查 · Teloa 官方目录收录（资源 a.b@1.0.0）；原作者 Acme，许可 MIT；兼容状态 compatible')
 const machine=marketTrustPreview({...base,trust:trust('从 GitHub a/b 机器固定收录（a.b@1.0.0）；来源 anthropics，许可 MIT；Teloa 官方目录脚本核验摘要，未逐行审核。')}).review
 assert.equal(machine,'已审查 · 从 GitHub a/b 自动收录（a.b@1.0.0）；来源 anthropics，许可 MIT；Teloa 官方目录脚本核验校验值，未逐行审核。')
 for(const text of [upstream,machine])assert.doesNotMatch(text,/上游|固定收录|摘要/)
})
