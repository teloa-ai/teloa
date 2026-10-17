import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {convertGrokRecipe,grokRecipeImportFromFiles,grokRecipeConnectorCandidates,grokRecipeConnectorMapping} from '../src/grok-recipe.ts'
import {readTemplateShare,readTemplateSharePackage,templateShareDigest} from '../src/template-share.mjs'

const connector=()=>({format:'teloa.market-catalog-entry/v1',id:'teloa.mcp-github',kind:'connector',delivery:'managed',version:'1.0.0',taxonomy:{functions:['dev-tools'],industries:['general']},upstream:null,connector:{serverName:'github',title:{'zh-CN':'原创连接测试',en:'Synthetic connector'},summary:{'zh-CN':'测试目录映射',en:'Test catalog mapping'},auth:{kind:'none'},recipe:{transport:'streamable-http',url:'https://example.invalid/mcp'},tools:[{name:'read_item',description:{'zh-CN':'读取',en:'Read'},readOnly:true}],upstreamUrl:'https://example.invalid'},modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-10-01',reviewer:'Synthetic'}})

const recipe=()=>({profile:{name:'原创研究员',title:'原创研究模板',description:'按来源核对结论。'},memory:[{kind:'log',createdAt:'2026-10-01T00:00:00Z',content:'作者示例参考，不是用户本人事实。'}],skills:[{name:'核对方法',description:'检查给定文本。',content:'---\nname: old-method\n---\n\n# 原正文\n完整保留。'}],routines:[{slug:'review',name:'定期复核',description:'核对本期资料。',content:'完整的例行方法。'}],plugins:[{pluginId:'original-app',name:'外部系统'}],gettingStarted:{skill:'核对方法'}})
test('recipe转换固定原件和资源摘要，保留原职责正文，重复转换不改变身份',async()=>{
 const raw=JSON.stringify(recipe()),first=await convertGrokRecipe(raw),second=await convertGrokRecipe(raw)
 assert.deepEqual(first,second);assert.equal(first.report.sourceHash,createHash('sha256').update(raw).digest('hex'))
 for(const file of first.files)assert.equal(file.hash,createHash('sha256').update(file.bytes).digest('hex'))
 assert.equal(new TextDecoder().decode(first.files.find(file=>file.path==='source/recipe.json')!.bytes),raw)
 assert.deepEqual(await grokRecipeImportFromFiles(first.files,first.manifestPath),first.report)
 assert.equal(first.report.gettingStarted?.skillResourceId,first.report.skills[0]?.resourceId)
 assert.ok(first.manifest.resources.some(row=>row.kind==='mcp'&&!row.required&&!first.files.some(file=>file.path===row.source.path)),'未匹配应用明确为缺项')
 const resourceKinds:readonly string[]=first.manifest.resources.map(row=>row.kind);assert.equal(resourceKinds.includes('plan'),false,'运行时输出不得生成持续计划')
})
test('模板默认进入通用工作，显式目标范围不充当资源命名空间；新技能名可读且防同名冲突',async()=>{
 const input={...recipe(),profile:{name:'Writer',title:'Writing helper',description:'Review writing.'},skills:[{name:'Evidence Review',description:'Review supplied text.',content:'# Original body'},{name:'Evidence Review',description:'Second method.',content:'# Other original body'}]},raw=JSON.stringify(input),general=await convertGrokRecipe(raw),target=await convertGrokRecipe(raw,{scope:'SOC'})
 assert.equal(general.manifest.scope,'general');assert.equal(target.manifest.scope,'SOC');assert.equal(general.report.sourceHash,target.report.sourceHash);assert.notEqual(general.hash,target.hash)
 const routine=target.files.find(file=>file.path==='routines/routine-0001.json')!;assert.equal(JSON.parse(new TextDecoder().decode(routine.bytes)).domain,'SOC')
 const skillFiles=general.files.filter(file=>file.path.endsWith('/SKILL.md')),names=skillFiles.map(file=>new TextDecoder().decode(file.bytes).match(/^name: (.+)$/m)?.[1]);assert.equal(new Set(names).size,skillFiles.length)
 const first=new TextDecoder().decode(skillFiles.find(file=>file.path==='skills/skill-0001/SKILL.md')!.bytes)
 assert.equal(first.match(/^name: (.+)$/m)?.[1],'writer-evidence-review-'+createHash('sha256').update(general.report.sourceHash+':skill-0001').digest('hex').slice(0,8))
 assert.ok(first.includes('description: "Evidence Review · Review supplied text."'));assert.ok(first.endsWith(input.skills[0]!.content))
 await assert.rejects(convertGrokRecipe(raw,{scope:'not/a/business'}),/业务范围/)
})
test('应用只能显式映射已有服务的合法固定定义；声明不等于连接',async()=>{
 const raw=JSON.stringify(recipe()),mapped=await convertGrokRecipe(raw,{pluginMappings:{'original-app':{kind:'mcp',definition:{format:'teloa.mcp-connection/v1',serverName:'reference',tools:['read_reference']}}}})
 assert.equal(mapped.report.plugins[0]?.state,'declared-not-connected')
 const resource=mapped.manifest.resources.find(row=>row.id===mapped.report.plugins[0]?.resourceId)!
 assert.deepEqual(JSON.parse(new TextDecoder().decode(mapped.files.find(file=>file.path===resource.source.path)!.bytes)),{format:'teloa.mcp-connection/v1',serverName:'reference',tools:['read_reference']})
 await assert.rejects(convertGrokRecipe(raw,{pluginMappings:{'original-app':{kind:'mcp',definition:{format:'teloa.mcp-connection/v1',serverName:'reference',tools:['read_reference'],url:'https://example.invalid',token:'must-not-export'} as never}}}),/格式|不正确/)
 await assert.rejects(convertGrokRecipe(raw,{pluginMappings:{'not-in-recipe':{kind:'mcp',definition:{format:'teloa.mcp-connection/v1',serverName:'reference',tools:['read_reference']}}}}),/不属于/)
})
test('未知执行字段和凭据拒绝，不执行正文中的命令或推断日程',async()=>{
 await assert.rejects(convertGrokRecipe(JSON.stringify({...recipe(),command:'never-run'})),/字段不受支持/)
 const unsafe=recipe();unsafe.skills[0]!.content='api_key='+('a'.repeat(32));await assert.rejects(convertGrokRecipe(JSON.stringify(unsafe)),/凭据/)
 const duplicate=recipe();duplicate.plugins.push({...duplicate.plugins[0]!});await assert.rejects(convertGrokRecipe(JSON.stringify(duplicate)),/pluginId 重复/)
 const changed=await convertGrokRecipe(JSON.stringify({...recipe(),profile:{...recipe().profile,name:'另一名字'}})),original=await convertGrokRecipe(JSON.stringify(recipe()));assert.notEqual(changed.manifest.id,original.manifest.id)
 const damaged=original.files.map(file=>file.path==='source/recipe.json'?{...file,bytes:new TextEncoder().encode('{}')}:file);await assert.rejects(grokRecipeImportFromFiles(damaged,original.manifestPath),/摘要不一致/)
 const spoofed=original.files.map(file=>file.path==='source/import.json'?{...file,bytes:new TextEncoder().encode(JSON.stringify({...original.report,skills:[{resourceId:'unrelated',title:'伪装技能'}]}))}:file);await assert.rejects(grokRecipeImportFromFiles(spoofed,original.manifestPath),/原件资源身份/)
})
test('profile 记忆按导入语义另生成固定方法技能：保留原件SHA与条目溯源，log 与知识参考不变，旧报告仍可回读',async()=>{
 const input={...recipe(),memory:[{kind:'profile',content:'Severity is one of blocker, worth fixing, or minor.'},{kind:'log',createdAt:'2026-10-01T00:00:00Z',content:'作者示例日志。'},{kind:'profile',createdAt:'2026-08-27',content:'Evidence hierarchy: A behavioral (payment).'}]},raw=JSON.stringify(input),pkg=await convertGrokRecipe(raw)
 const method=pkg.manifest.resources.find(row=>row.id==='method-reference')!
 assert.equal(pkg.manifest.version,'1.0.1','增加工作准则使用新的转换包版本，不替换旧1.0.0固定输入')
 assert.ok(pkg.manifest.resources.every(row=>row.version==='1.0.0'),'原职责与原子资源版本保持，新方法为首次1.0.0')
 assert.equal(method.kind,'skill');assert.ok(pkg.manifest.relations.some(link=>link.kind==='role-skill'&&link.from==='employee'&&link.to==='method-reference'))
 assert.equal(pkg.manifest.entrypoints.includes('method-reference'),false,'工作准则不是独立入口')
 const markdown=new TextDecoder().decode(pkg.files.find(file=>file.path===method.source.path)!.bytes)
 assert.equal(markdown.match(/^name: (.+)$/m)?.[1],'assistant-method-'+createHash('sha256').update(pkg.report.sourceHash+':method-reference').digest('hex').slice(0,8))
 assert.ok(markdown.includes(pkg.report.sourceHash),'正文写明原件 SHA');assert.ok(markdown.includes('memory[1]')&&markdown.includes('memory[3]')&&!markdown.includes('memory[2]'),'逐条标注原 memory 序号')
 assert.ok(markdown.indexOf('Severity is one of')<markdown.indexOf('Evidence hierarchy'));assert.equal(markdown.includes('作者示例日志'),false,'log 不进入方法')
 assert.deepEqual(pkg.report.memory,{resourceIds:['memory-0001','memory-0002','memory-0003'],importedAs:'template-reference',method:{resourceId:'method-reference',memoryIndexes:[0,2]}})
 assert.equal(pkg.manifest.resources.filter(row=>row.kind==='knowledge'&&row.id.startsWith('memory-')).length,3,'知识参考保持原样')
 assert.equal(pkg.report.skills.length,1);assert.equal(pkg.report.gettingStarted?.skillResourceId,'skill-0001')
 assert.deepEqual(await grokRecipeImportFromFiles(pkg.files,pkg.manifestPath),pkg.report)
 const legacy=await convertGrokRecipe(JSON.stringify(recipe()));assert.equal(legacy.report.memory.method,undefined,'没有 profile 记忆就没有方法技能')
 assert.equal(legacy.manifest.version,'1.0.0','没有方法扩展的原模板转换版本保持')
 const {method:_omitted,...withoutMethod}=pkg.report.memory,legacyReport={...pkg.report,memory:withoutMethod}
 const oldFiles=pkg.files.filter(file=>file.path!==method.source.path).map(file=>file.path==='source/import.json'?{...file,bytes:new TextEncoder().encode(JSON.stringify(legacyReport))}:file)
 assert.deepEqual(await grokRecipeImportFromFiles(oldFiles,pkg.manifestPath),legacyReport,'旧包没有方法技能也不得伪造')
 const spoofed=pkg.files.map(file=>file.path==='source/import.json'?{...file,bytes:new TextEncoder().encode(JSON.stringify({...pkg.report,memory:{...pkg.report.memory,method:{resourceId:'method-reference',memoryIndexes:[0,1,2]}}}))}:file)
 await assert.rejects(grokRecipeImportFromFiles(spoofed,pkg.manifestPath),/原件资源身份/)
 const missing=pkg.files.filter(file=>file.path!==method.source.path)
 await assert.rejects(grokRecipeImportFromFiles(missing,pkg.manifestPath),/原件资源身份/)
})
test('应用对照只接受固定原ID与宿主已审目录；用户显式选工具后仍只是未连接声明',async()=>{
 const input={...recipe(),plugins:[{pluginId:'48677658',name:'原GitHub应用'},{pluginId:'not-known',name:'GitHub'}]},entry=connector()
 const candidates=grokRecipeConnectorCandidates(input,[entry]);assert.equal(candidates.length,1);assert.equal(candidates[0]?.pluginId,'48677658');assert.equal(candidates[0]?.catalogEntryId,'teloa.mcp-github')
 assert.deepEqual(grokRecipeConnectorCandidates(input,[{...entry,id:'synthetic.same-name'}]),[])
 assert.throws(()=>grokRecipeConnectorCandidates(input,[{...entry,review:{...entry.review,status:'pending'}}]),{code:'teloa/invalid-input',message:'目录只收录审核通过的条目。'})
 const mapping=grokRecipeConnectorMapping(input,{pluginId:'48677658',catalogEntryId:'teloa.mcp-github',tools:['read_item']},[entry])
 assert.deepEqual(mapping,{kind:'mcp',definition:{format:'teloa.mcp-connection/v1',serverName:'github',tools:['read_item']}})
 const twoTools={...entry,connector:{...entry.connector,tools:[...entry.connector.tools,{name:'list_items',description:{'zh-CN':'列表',en:'List'},readOnly:true}]}},selection={pluginId:'48677658',catalogEntryId:'teloa.mcp-github',tools:['read_item','list_items']}
 assert.deepEqual(grokRecipeConnectorMapping(input,selection,[twoTools]),grokRecipeConnectorMapping(input,{...selection,tools:[...selection.tools].reverse()},[twoTools]),'同一工具集合不因点击顺序产生第二份固定内容')
 const converted=await convertGrokRecipe(JSON.stringify(input),{pluginMappings:{'48677658':mapping}});assert.equal(converted.report.plugins[0]?.state,'declared-not-connected');assert.equal(converted.report.plugins[1]?.state,'needs-configuration')
 assert.throws(()=>grokRecipeConnectorMapping(input,{pluginId:'not-known',catalogEntryId:'teloa.mcp-github',tools:['read_item']},[entry]),/已审目录/)
 assert.throws(()=>grokRecipeConnectorMapping(input,{pluginId:'48677658',catalogEntryId:'teloa.mcp-github',tools:['write_arbitrary']},[entry]),/工具/)
 assert.throws(()=>grokRecipeConnectorMapping(input,{pluginId:'48677658',catalogEntryId:'teloa.mcp-github',tools:[]},[{...entry,connector:{...entry.connector,tools:[]}}]),/工具/)
})
test('转换包按 v2 AI 员工分享往返：原件以 sourceFiles 声明，固定摘要与导入报告可核对，v1 读取器仍拒绝',async()=>{
 const raw=JSON.stringify(recipe()),decode=(bytes:Uint8Array)=>new TextDecoder().decode(bytes)
 const mapped=await convertGrokRecipe(raw,{pluginMappings:{'original-app':{kind:'mcp',definition:{format:'teloa.mcp-connection/v1',serverName:'reference',tools:['read_reference']}}}})
 for(const converted of [await convertGrokRecipe(raw),mapped]){
  const files=converted.files.map(file=>({path:file.path,text:decode(file.bytes)}))
  const pkg={format:'teloa.template-share/v2',subject:'employee',id:converted.manifest.id,version:converted.manifest.version,title:converted.manifest.title,description:converted.manifest.description,requirements:['在原连接入口配置所需应用。'],license:'CC-BY-4.0',trust:{publisher:'Original template author'},provenance:{sources:[{title:'Original template',license:'CC-BY-4.0',resourceIds:converted.report.skills.map(row=>row.resourceId)}],modifications:'Converted to Teloa resources; skill bodies unchanged.'},sourceFiles:['source/import.json','source/recipe.json'],compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:['people','connections']},files}
  const checked=readTemplateShare(pkg)
  assert.equal(checked.format,'teloa.template-share/v2');assert.equal(checked.id,converted.manifest.id,'沿用转换包的安全 slug 身份')
  const back=checked.files.map(file=>({path:file.path,bytes:new TextEncoder().encode(file.text)}))
  for(const file of converted.files)assert.equal(createHash('sha256').update(back.find(row=>row.path===file.path)!.bytes).digest('hex'),file.hash,file.path)
  assert.deepEqual(await grokRecipeImportFromFiles(back,'teloa.json'),converted.report,'往返后原件与导入报告仍可核对')
  assert.equal(await templateShareDigest({...pkg,files:[...files].reverse()}),await templateShareDigest(checked))
  assert.throws(()=>readTemplateShare({...pkg,sourceFiles:['source/recipe.json']}),/undeclared JSON/,'未声明的原件 JSON 不能放行')
  assert.throws(()=>readTemplateShare({...pkg,compatibility:{...pkg.compatibility,capabilities:['people']}}),/undeclared capability/,'连接需求不能静默降级')
  const {subject:_subject,license:_license,trust:_trust,provenance:_provenance,sourceFiles:_sourceFiles,...v1Shape}=pkg
  assert.throws(()=>readTemplateSharePackage({...v1Shape,format:'teloa.template-share/v1'}),/format or identity/,'v1 读取器仍拒绝 slug 身份的转换包')
 }
})
