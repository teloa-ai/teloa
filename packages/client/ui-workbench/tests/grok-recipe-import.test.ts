import test from 'node:test'
import assert from 'node:assert/strict'
import {parseMarketManifest,itemFromManifest,readGrokRecipeItemSource,reprepareGrokRecipeItem} from '../src/client/market-preview.ts'
import {discoverIndustryTemplates} from '../src/client/industry-directory.ts'

// 原创夹具；不包含下载模板、账号、真实凭据或外部应用调用。
const recipe=()=>({profile:{name:'资料核对员',title:'核对资料',description:'核对输入资料并明确说明证据缺口。'},memory:[{kind:'profile',content:'这是模板作者的工作偏好，不能当作用户本人已确认事实。'},{kind:'log',content:'模板示例日志，仅作参考。'}],skills:[{name:'证据核对',description:'比较输入证据并报告差异。',content:'# 原技能正文\n保留“引号”、换行和代码块。\n```text\nexample\n```\n'}],routines:[{slug:'weekly-review',name:'例行核对',description:'复核本周期新增资料。',content:'逐条复核资料。\n没有明确时间和时区时不要启动。'}],plugins:[{pluginId:'foreign-app',name:'外部应用',description:'读取授权后的记录。'}],gettingStarted:{skill:'证据核对'}})

test('单一recipe通过原解析入口得到完整可持久化包，正文冻结且计划/连接未启用',async()=>{
 const raw=JSON.stringify(recipe()),parsed=await parseMarketManifest(raw),item=itemFromManifest(parsed,{kind:'upload',name:'recipe.json',size:new TextEncoder().encode(raw).length})
 assert.equal(item.manifest?.format,'teloa.business-package/v2');assert.ok(item.packageContent)
 assert.equal(item.recipeImport?.format,'teloa.grok-recipe-import/v1');assert.equal(item.recipeImport?.plugins[0]?.state,'needs-configuration');assert.equal(item.recipeImport?.routines[0]?.state,'needs-schedule');assert.equal(item.recipeImport?.memory.importedAs,'template-reference')
 const files=new Map(item.packageContent.files.map(file=>[file.path,new TextDecoder().decode(file.bytes)]))
 assert.equal(files.get('source/recipe.json'),raw);assert.ok([...files.values()].some(value=>value.endsWith(recipe().skills[0]!.content)))
 assert.ok([...files.values()].some(value=>value.endsWith(recipe().routines[0]!.content)))
 const role=JSON.parse(files.get('roles/employee.json')!);assert.equal(role.name,recipe().profile.name);assert.equal(role.duty,recipe().profile.description);assert.equal(role.kind,'employee')
 assert.ok('resources'in item.manifest!);assert.equal(item.manifest.resources.some(row=>row.kind==='plan'),false,'缺日程不造持续计划')
 const again=itemFromManifest(await parseMarketManifest(raw),item.source);assert.equal(again.id,item.id);assert.equal(again.packageContent?.hash,item.packageContent.hash)
})

test('目录和压缩包发现共用recipe适配，错误recipe不静默忽略',async()=>{
 const raw=JSON.stringify(recipe()),bytes=new TextEncoder().encode(raw),results=await discoverIndustryTemplates([{path:'bot/recipe.json',size:bytes.length,read:async()=>bytes}],'bot')
 assert.equal(results.length,1);assert.equal(results[0]?.path,'bot/recipe.json');assert.ok(results[0]?.item?.packageContent);assert.ok(results[0]?.item?.recipeImport)
 const invalid=new TextEncoder().encode(JSON.stringify({...recipe(),command:'do-not-run'})),failed=await discoverIndustryTemplates([{path:'bad/recipe.json',size:invalid.length,read:async()=>invalid}],'bad')
 assert.equal(failed.length,1);assert.ok(failed[0]?.error)
})

test('固定包原件读取与重新准备走同一解析；原SHA不变、映射包摘要变化且不覆盖已保存对象',async()=>{
 const raw=JSON.stringify(recipe()),item=itemFromManifest(await parseMarketManifest(raw),{kind:'upload',name:'recipe.json',size:new TextEncoder().encode(raw).length})
 const source=await readGrokRecipeItemSource(item);assert.equal(source.raw,raw);assert.deepEqual(source.recipe,recipe());assert.equal(source.sourceHash,item.recipeImport?.sourceHash)
 const mapping={'foreign-app':{kind:'mcp' as const,definition:{format:'teloa.mcp-connection/v1' as const,serverName:'reference',tools:['read_reference']}}},prepared=await reprepareGrokRecipeItem(item,mapping),again=await reprepareGrokRecipeItem(item,mapping)
 assert.equal(prepared.recipeImport?.sourceHash,source.sourceHash);assert.notEqual(prepared.packageContent?.hash,item.packageContent?.hash);assert.notEqual(prepared.id,item.id);assert.equal(prepared.id,again.id)
 assert.equal(prepared.manifest?.id,item.manifest?.id);assert.equal(prepared.version,item.version);assert.equal(prepared.recipeImport?.plugins[0]?.state,'declared-not-connected');assert.equal(item.recipeImport?.plugins[0]?.state,'needs-configuration');assert.equal(prepared.source.kind,'upload');assert.equal(prepared.contentStorage,undefined)
 const sourceAgain=await readGrokRecipeItemSource(prepared);assert.equal(sourceAgain.raw,raw)
 assert.equal(prepared.scope,'general');const scoped=await reprepareGrokRecipeItem(item,mapping,{scope:'SOC'});assert.equal(scoped.scope,'SOC');assert.equal(scoped.recipeImport?.sourceHash,source.sourceHash);assert.notEqual(scoped.packageContent?.hash,prepared.packageContent?.hash);assert.equal((await reprepareGrokRecipeItem(scoped,mapping)).scope,'SOC')
 await assert.rejects(reprepareGrokRecipeItem({...item,contentStorage:{contentId:'existing',createdAt:'2026-10-01T00:00:00Z',loaded:false}},mapping),/已保存/)
 const damaged={...item,packageContent:{...item.packageContent!,files:item.packageContent!.files.map(file=>file.path==='source/recipe.json'?{...file,bytes:new TextEncoder().encode('{}')}:file)}};await assert.rejects(readGrokRecipeItemSource(damaged),{message:'模板文件已变化，请重新选择原模板。'})
 await assert.rejects(readGrokRecipeItemSource({...item,packageContent:{...item.packageContent!,hash:'a'.repeat(64)}}),{message:'模板内容已变化，请重新选择原模板。'})
})

test('导入入口三类定稿语言使用员工团队模板，不把兼容来源品牌作为产品概念',async()=>{
 const {MARKET_FORM_MESSAGE_ROWS}=await import('../src/client/i18n/locales/market-forms.ts')
 const row=(key:string)=>MARKET_FORM_MESSAGE_ROWS.find(value=>value[0]===key)!
 const keys=['market.forms.the.first.v2.industry.templates.are.supported.by','market.forms.the.industry.templates.are.industry.positioning.by.normative','market.forms.select.a.list.of.v2.industries','market.forms.telea.work.template.v1.or.telea.business.package','market.forms.no.recognizable.industry.list.in.the.fixed.source']
 for(const key of keys)for(const value of row(key).slice(1,4)){
  assert.doesNotMatch(String(value),/\bv[123]\b|business-package\/|work-template\/|Grok|任务模板|行業模板|行业模板/,key)
  assert.match(String(value),/模板|员工|範本|員工|template|employee/i,key)
 }
})
