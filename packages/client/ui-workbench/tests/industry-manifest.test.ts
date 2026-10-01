import test from 'node:test'
import assert from 'node:assert/strict'
import { industryResourceLabels, validateIndustryManifest } from '../src/client/industry-manifest.ts'
import { parseMarketManifest, itemFromManifest } from '../src/client/market-preview.ts'
import {readFileSync} from 'node:fs'
import {builtinIndustryManifests} from '../src/client/builtin-industry-manifests.ts'
import {localizedIndustryResourceTitle} from '../src/client/industry-template-presentation.ts'

const resource=(id:string,kind:string,path:string)=>({id,kind,title:id,version:'1.0.0',required:true,source:{kind:'local',path}})
const definition=()=>({format:'teloa.business-package/v2',id:'security',title:'安全运营',version:'1.0.0',domain:'security',description:'调查与协作',resources:[resource('investigator','role','roles/investigator.json'),resource('handbook','knowledge','knowledge/handbook.md'),resource('investigate','skill','skills/investigate/SKILL.md'),resource('alerts','mcp','connections/alerts.json'),resource('triage','work-template','tasks/triage.json')],relations:[{kind:'role-knowledge',from:'investigator',to:'handbook'},{kind:'role-skill',from:'investigator',to:'investigate'},{kind:'role-connection',from:'investigator',to:'alerts'},{kind:'role-work',from:'investigator',to:'triage'}],entrypoints:['triage']})

test('内置模板和真实示例目录提供完整双语元数据，其他语言资源目录回退英文',()=>{
 const examples=['通用研究','安全运营'].map(name=>validateIndustryManifest(JSON.parse(readFileSync(new URL(`../../../../examples/industry/${name}/teloa.json`,import.meta.url),'utf8'))))
 for(const manifest of [...Object.values(builtinIndustryManifests),...examples]){
  for(const [original,localized] of [[manifest.title,manifest.localized?.title],[manifest.description,manifest.localized?.description],...manifest.resources.map(row=>[row.title,row.localized?.title] as const)] as const){
   assert.ok(localized,`${manifest.id}: ${original} 缺少本地化元数据`)
   assert.equal(localized.original,original)
   assert.equal(localized.defaultLocale,'en')
   assert.equal(localized.locales['zh-CN'],original)
   assert.equal(typeof localized.locales.en,'string')
   assert.ok((localized.locales.en as string).trim())
   assert.doesNotMatch(localized.locales.en as string,/\p{Script=Han}/u)
  }
  for(const row of manifest.resources){
   assert.equal(localizedIndustryResourceTitle(row,'de'),row.localized!.title!.locales.en)
   assert.equal(localizedIndustryResourceTitle(row,'zh-CN'),row.title)
  }
 }
 assert.equal(localizedIndustryResourceTitle(builtinIndustryManifests['bundle-security'].resources[0]!,'en'),'SOC investigator')
})

test('市场解析入口接受完整行业集合，但不将清单解析误报为加载成功',async()=>{
 const parsed=await parseMarketManifest(JSON.stringify(definition()))
 const item=itemFromManifest(parsed,{kind:'paste'})
 assert.equal(item.kind,'bundle')
 assert.equal(item.components.length,5)
 assert.ok(item.components.some(value=>value.name.includes('handbook')))
 assert.match(item.compatibility,/未加载/)
 assert.equal(item.manifest?.format,'teloa.business-package/v2')
})

test('行业集合保留知识、岗位、技能、连接、工作入口及其关联',()=>{
 const result=validateIndustryManifest(definition())
 assert.equal(result.resources.length,5)
 assert.deepEqual(result.relations[0],{kind:'role-knowledge',from:'investigator',to:'handbook'})
 assert.deepEqual(result.entrypoints,['triage'])
})
test('行业归类与加载后的业务范围可分开，旧清单仍以行业归类作为范围',()=>{
 const split=validateIndustryManifest({...definition(),domain:'security',scope:'SOC'})
 assert.equal(split.domain,'security')
 assert.equal(split.scope,'SOC')
 assert.equal(validateIndustryManifest(definition()).scope,'security')
 assert.throws(()=>validateIndustryManifest({...definition(),scope:'安全运营'}),/业务范围/)
})
test('市场目录以业务范围作为加载目标，而行业归类仍保留给资源索引',async()=>{
 const item=itemFromManifest(await parseMarketManifest(JSON.stringify({...definition(),domain:'security',scope:'SOC'})),{kind:'paste'})
 assert.equal(item.scope,'SOC')
 assert.equal(item.manifest?.format,'teloa.business-package/v2')
 if(item.manifest?.format==='teloa.business-package/v2')assert.equal(item.manifest.domain,'security')
})
test('市场资源标签使用同事模板与知识的统一产品术语',()=>{
 assert.equal(industryResourceLabels.role,'员工模板')
 assert.equal(industryResourceLabels.knowledge,'知识')
})
test('公共资源固定身份与版本，不用同名项冒充本地组件',()=>{
 const raw=definition()
 const shared={...raw,resources:[...raw.resources.slice(0,2),{id:'investigate',kind:'skill',title:'调查',version:'1.0.0',required:true,source:{kind:'public',id:'public-investigate',version:'1.0.0'}},...raw.resources.slice(3)]}
 assert.equal(validateIndustryManifest(shared).resources[2]?.source.kind,'public')
 assert.throws(()=>validateIndustryManifest({...shared,resources:[{...shared.resources[2],source:{kind:'public',id:'public-investigate',version:'latest'}}]}),/版本|引用/)
})
test('重复身份、悬空关系、错误关系类型与无效入口明确拒绝',()=>{
 const raw=definition()
 assert.throws(()=>validateIndustryManifest({...raw,resources:[...raw.resources,raw.resources[0]]}),/重复/)
 assert.throws(()=>validateIndustryManifest({...raw,relations:[{kind:'role-knowledge',from:'investigator',to:'missing'}]}),/不存在/)
 assert.throws(()=>validateIndustryManifest({...raw,relations:[{kind:'role-knowledge',from:'investigator',to:'alerts'}]}),/类型/)
 assert.throws(()=>validateIndustryManifest({...raw,entrypoints:['handbook']}),/入口/)
})
test('包内路径与未知字段拒绝，清单不读取或执行内容',()=>{
 for(const path of ['../secret','/root/file','a\\b','a/%2e/file','a//file'])assert.throws(()=>validateIndustryManifest({...definition(),resources:[resource('x','skill',path)]}),/路径/)
 assert.throws(()=>validateIndustryManifest({...definition(),apiKey:'not-allowed'}),/未知字段/)
 assert.throws(()=>validateIndustryManifest({...definition(),resources:[{...resource('x','skill','x'),required:'yes'}]}),/required/)
})

test('行业模板只把可选本地化元数据附着到稳定标题和说明',()=>{
 const raw={...definition(),localized:{
  title:{original:'安全运营',defaultLocale:'en',locales:{en:'Security operations','zh-Hant':'安全營運','zh-TW':{fallback:'zh-Hant'}}},
  description:{original:'调查与协作',defaultLocale:'en',locales:{en:'Investigation and collaboration'}},
 }}
 const result=validateIndustryManifest(raw)
 assert.deepEqual(result.localized,raw.localized)
 assert.equal(result.title,'安全运营')
 assert.equal(result.description,'调查与协作')
 assert.throws(()=>validateIndustryManifest({...raw,localized:{...raw.localized,title:{...raw.localized.title,original:'另一标题'}}}),/稳定原文/)
 assert.throws(()=>validateIndustryManifest({...raw,localized:{...raw.localized,title:{...raw.localized.title,locales:{en:{fallback:'fr'},fr:{fallback:'en'}}}}}),/fallback/)
})

test('行业资源标题保留稳定原文并校验自己的本地化元数据',()=>{
 const raw=definition()
 const localized={original:'investigator',defaultLocale:'en',locales:{en:'Investigator','zh-CN':'调查员','zh-Hant':{fallback:'zh-CN'}}}
 const resources=raw.resources.map((item,index)=>index===0?{...item,localized:{title:localized}}:item)
 const result=validateIndustryManifest({...raw,resources})
 assert.deepEqual(result.resources[0]?.localized?.title,localized)
 assert.equal(result.resources[0]?.title,'investigator')
 assert.throws(()=>validateIndustryManifest({...raw,resources:[{...resources[0],localized:{title:{...localized,original:'other'}}},...resources.slice(1)]}),/稳定原文/)
 assert.throws(()=>validateIndustryManifest({...raw,resources:[{...resources[0],localized:{description:localized}},...resources.slice(1)]}),/未知字段/)
})


test('v3 模型依赖经市场解析保留，v2 不静默接收新字段',async()=>{
 const raw=definition(),dependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
 const resources=raw.resources.map(item=>item.kind==='work-template'?{...item,modelDependencies:[dependency]}:item)
 assert.throws(()=>validateIndustryManifest({...raw,resources}),/未知字段/)
 const parsed=await parseMarketManifest(JSON.stringify({...raw,format:'teloa.business-package/v3',resources}))
 const item=itemFromManifest(parsed,{kind:'paste'})
 assert.equal(item.manifest?.format,'teloa.business-package/v3')
 assert.deepEqual(validateIndustryManifest(parsed.manifest).resources.find(row=>row.kind==='work-template')?.modelDependencies,[dependency])
 assert.throws(()=>validateIndustryManifest({...raw,format:'teloa.business-package/v3',resources:[{...resources[0],modelDependencies:[dependency]}]}),/模型依赖/)
})


test('v4 可携带业务配置资源，旧版拒绝配置资源且不会产生权限',()=>{
 const config=resource('overview','business-configuration','dashboard.json')
 const raw={...definition(),resources:[config],relations:[],entrypoints:[]}
 assert.equal(validateIndustryManifest({...raw,format:'teloa.business-package/v4'}).resources[0]?.kind,'business-configuration')
 for(const format of ['teloa.business-package/v2','teloa.business-package/v3'])assert.throws(()=>validateIndustryManifest({...raw,format}),/v4|配置/)
})
