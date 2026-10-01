import test from 'node:test'
import assert from 'node:assert/strict'
import {marketPublicationMetadata} from '../src/index.ts'
import {validateManifest} from '../src/market/content-store.ts'

const field=(original:string,en:string,zhCN:string)=>({
 original,
 defaultLocale:'en',
 locales:{en,'zh-CN':zhCN,'zh-Hant':{fallback:'zh-CN'}},
})

const industryManifest=()=>({
 format:'teloa.business-package/v2',id:'security',title:'安全行业模板',version:'1.0.0',domain:'security',description:'安全运营与应用安全工作模板。',
 localized:{title:field('安全行业模板','Security industry template','安全行业模板'),description:field('安全运营与应用安全工作模板。','Work templates for security operations and application security.','安全运营与应用安全工作模板。')},
 resources:[{id:'analyst',kind:'role',title:'分析员',localized:{title:field('分析员','Analyst','分析员')},version:'1.0.0',required:true,source:{kind:'local',path:'roles/analyst.json'}}],relations:[],entrypoints:[],
})

test('独立 Skill 公开发布要求标题同时提供简体中文和英文，并固定英文为默认回退',()=>{
 const metadata={id:'report-writing',title:'报告撰写',version:'1.0.0',categories:['writing'],localized:{title:field('报告撰写','Report writing','报告撰写')}}
 const result=marketPublicationMetadata({kind:'atomic-skill',metadata})
 assert.deepEqual(result.requiredLocales,['zh-CN','en'])
 assert.deepEqual(result.localized.title,metadata.localized.title)
 assert.deepEqual(result.resources,[])

 for(const localized of [
  undefined,
  {title:{original:'报告撰写',defaultLocale:'en',locales:{en:'Report writing'}}},
  {title:{original:'报告撰写',defaultLocale:'en',locales:{en:'Report writing','zh-CN':{fallback:'en'}}}},
  {title:{original:'报告撰写',defaultLocale:'zh-CN',locales:{en:'Report writing','zh-CN':'报告撰写'}}},
 ])assert.throws(()=>marketPublicationMetadata({kind:'atomic-skill',metadata:{...metadata,localized}}),/公开发布|简体中文|英文/)
})

test('行业模板公开发布要求名称和说明都提供简体中文和英文',()=>{
 const manifest=industryManifest()
 const result=marketPublicationMetadata({kind:'industry-template',metadata:manifest})
 assert.deepEqual(result.requiredLocales,['zh-CN','en'])
 assert.equal(result.localized.title.locales.en,'Security industry template')
 assert.equal(result.localized.description!.locales['zh-CN'],'安全运营与应用安全工作模板。')
 assert.deepEqual(result.resources,[{id:'analyst',title:field('分析员','Analyst','分析员')}])

 const missingDescription={...manifest,localized:{title:manifest.localized.title}}
 assert.throws(()=>marketPublicationMetadata({kind:'industry-template',metadata:missingDescription}),/说明.*公开发布|公开发布.*说明/)
 const missingResourceLocale={...manifest,resources:[{...manifest.resources[0],localized:undefined}]}
 assert.throws(()=>marketPublicationMetadata({kind:'industry-template',metadata:missingResourceLocale}),/资源.*分析员.*公开发布|公开发布.*资源.*分析员/)
})

for(const [label,title] of [
 ['缺少英文',{original:'分析员',defaultLocale:'en',locales:{'zh-CN':'分析员'}}],
 ['缺少简体中文',{original:'分析员',defaultLocale:'en',locales:{en:'Analyst'}}],
 ['英文使用 fallback',{original:'分析员',defaultLocale:'en',locales:{en:{fallback:'zh-CN'},'zh-CN':'分析员'}}],
 ['简体中文使用 fallback',{original:'分析员',defaultLocale:'en',locales:{en:'Analyst','zh-CN':{fallback:'en'}}}],
 ['默认回退不是英文',{original:'分析员',defaultLocale:'zh-CN',locales:{en:'Analyst','zh-CN':'分析员'}}],
] as const)test('行业资源公开发布拒绝'+label,()=>{
 const manifest=industryManifest()
 const metadata={...manifest,resources:[{...manifest.resources[0],localized:{title}}]}
 assert.throws(()=>marketPublicationMetadata({kind:'industry-template',metadata}),/资源.*分析员.*公开发布/)
})

test('公开发布逐项核验资源，不因资源可选或公共引用而跳过',()=>{
 const manifest=industryManifest()
 for(const source of [{kind:'local',path:'optional.md'},{kind:'public',id:'optional',version:'1.0.0'}]){
  const metadata={...manifest,resources:[...manifest.resources,{id:'optional',kind:'skill',title:'可选方法',version:'1.0.0',required:false,source}]}
  assert.throws(()=>marketPublicationMetadata({kind:'industry-template',metadata}),/资源.*可选方法.*公开发布/)
 }
})

test('私有行业清单保留资源本地化标题，也允许没有本地化元数据',()=>{
 const manifest=industryManifest()
 assert.deepEqual(validateManifest(manifest).resources[0]?.localized,{title:field('分析员','Analyst','分析员')})
 const metadata={...manifest,localized:undefined,resources:[{...manifest.resources[0],localized:undefined}]}
 const normalized=validateManifest(metadata)
 assert.equal(Object.hasOwn(normalized,'localized'),false)
 assert.equal(Object.hasOwn(normalized.resources[0]!,'localized'),false)
})

test('行业归类与加载业务范围分别固定，未声明范围的旧清单兼容行业归类',()=>{
 const manifest=industryManifest()
 const split=validateManifest({...manifest,domain:'security',scope:'SOC'})
 assert.equal(split.domain,'security')
 assert.equal(split.scope,'SOC')
 assert.equal(validateManifest(manifest).scope,'security')
 assert.throws(()=>validateManifest({...manifest,scope:'安全运营'}),{code:'teloa/invalid-input'})
})

test('行业资源本地化稳定原文必须与资源标题一致',()=>{
 const manifest=industryManifest()
 const metadata={...manifest,resources:[{...manifest.resources[0],localized:{title:field('其他分析员','Analyst','分析员')}}]}
 assert.throws(()=>validateManifest(metadata),/稳定原文/)
 assert.throws(()=>marketPublicationMetadata({kind:'industry-template',metadata}),/稳定原文/)
})

test('行业资源本地化只允许标题，拒绝未知字段和非法本地化结构',()=>{
 const manifest=industryManifest(),title=field('分析员','Analyst','分析员')
 for(const localized of [
  {title,description:field('说明','Description','说明')},
  {title,description:undefined},
  {title,unknown:true},
  {title:{...title,unknown:true}},
  {title:{...title,locales:{en:'Analyst','zh-CN':' '}}},
  {title:{...title,locales:{en:{fallback:'missing'},'zh-CN':'分析员'}}},
 ])assert.throws(()=>validateManifest({...manifest,resources:[{...manifest.resources[0],localized}]}),{code:'teloa/invalid-input'})
})
