import assert from 'node:assert/strict'
import test from 'node:test'
import {describeIndustryInspection,describeIndustryResourceSource,describeIndustryLoadTarget,describeIndustryResourceDestinations,isBusinessDeclarationPackage,localizedIndustryResourceTitle,localizedIndustryTemplateMetadata} from '../src/client/industry-template-presentation.ts'
import type {IndustryManifest} from '../src/client/industry-manifest.ts'

test('资源核验状态使用用户可采取行动的说明',()=>{
  assert.deepEqual(describeIndustryInspection(undefined),{label:'内容待读取',tone:'neutral'})
  assert.deepEqual(describeIndustryInspection({state:'parsed',message:'内容已解析。'}),{label:'内容可预览',tone:'ready'})
  assert.deepEqual(describeIndustryInspection({state:'pending',message:'等待适配。'}),{label:'等待适配',tone:'pending'})
  assert.deepEqual(describeIndustryInspection({state:'missing',message:'缺少文件。'}),{label:'缺少内容',tone:'warning'})
  assert.deepEqual(describeIndustryInspection({state:'unresolved',message:'引用待解析。'}),{label:'引用待核对',tone:'pending'})
  assert.deepEqual(describeIndustryInspection({state:'invalid',message:'格式错误。'}),{label:'内容有问题',tone:'warning'})
})

test('资源来源默认展示用户语言并把技术身份留到治理信息',()=>{
  assert.equal(describeIndustryResourceSource({kind:'local',path:'skills/a/SKILL.md'}),'随模板提供')
  assert.equal(describeIndustryResourceSource({kind:'public',id:'skill-a',version:'1.2.0'}),'引用公共资源 · v1.2.0')
})

test('加载确认摘要明确目标与加载后的真实效果',()=>{
  assert.deepEqual(describeIndustryLoadTarget('new','安全运营',undefined),{
    target:'新建工作空间「安全运营」',
    effect:'登记模板资源与关联关系；员工、技能、连接和计划仍需逐项启用。',
  })
  assert.deepEqual(describeIndustryLoadTarget('existing','',{name:'SOC',version:3}),{
    target:'已有工作空间「SOC」· v3',
    effect:'把模板资源登记到当前空间；不会覆盖已有员工、任务或计划。',
  })
})

test('行业模板资源按类型显示唯一落点而不全部塞入技能',()=>{
 const resources:IndustryManifest['resources']=[
  {id:'role',kind:'role',title:'调查岗',version:'1.0.0',required:true,source:{kind:'local',path:'roles/investigator.json'}},
  {id:'guide',kind:'knowledge',title:'调查手册',version:'1.0.0',required:true,source:{kind:'local',path:'knowledge/guide.md'}},
  {id:'skill',kind:'skill',title:'告警研判',version:'1.0.0',required:true,source:{kind:'local',path:'skills/review/SKILL.md'}},
  {id:'events',kind:'data-source',title:'告警数据',version:'1.0.0',required:true,source:{kind:'local',path:'connections/events.json'}},
  {id:'action',kind:'execution-tool',title:'隔离终端',version:'1.0.0',required:false,source:{kind:'local',path:'tools/isolate.json'}},
  {id:'work',kind:'work-template',title:'告警调查',version:'1.0.0',required:true,source:{kind:'local',path:'work/investigate.json'}},
  {id:'plan',kind:'plan',title:'每日巡检',version:'1.0.0',required:false,source:{kind:'local',path:'plans/daily.json'}},
 ]
 assert.deepEqual(describeIndustryResourceDestinations(resources),[
  {destination:'员工',count:1},
  {destination:'资料',count:1},
  {destination:'技能',count:1},
  {destination:'任务',count:1},
  {destination:'自动化',count:1},
  {destination:'业务空间 · 数据',count:1},
  {destination:'业务空间 · 执行',count:1},
 ])
})

test('资源稀疏的模板显示八个工作空间落点与市场扩展入口',()=>{
 const resources:IndustryManifest['resources']=[
  {id:'role',kind:'role',title:'研究岗',version:'1.0.0',required:true,source:{kind:'local',path:'roles/researcher.json'}},
 ]
 assert.deepEqual(describeIndustryResourceDestinations(resources,{includeEmpty:true}),[
  {destination:'员工',count:1},
  {destination:'资料',count:0},
  {destination:'技能',count:0},
  {destination:'市场 · 扩展',count:0},
  {destination:'任务',count:0},
  {destination:'自动化',count:0},
  {destination:'业务空间 · 数据',count:0},
  {destination:'业务空间 · 执行',count:0},
  {destination:'业务空间 · 台账',count:0},
 ])
})

test('只含业务声明与来源身份的包独立识别，含任何能力或可执行资源就不是最小权限面',()=>{
 assert.equal(isBusinessDeclarationPackage([{kind:'data-source'},{kind:'object-type'},{kind:'business-view'},{kind:'business-action'}]),true)
 assert.equal(isBusinessDeclarationPackage([{kind:'object-type'},{kind:'work-template'}]),false)
 assert.equal(isBusinessDeclarationPackage([]),false)
})

test('行业模板展示按 locale 解析标题和说明且不改写稳定原文',()=>{
 const manifest={title:'研究行业',description:'稳定说明',localized:{
  title:{original:'研究行业',defaultLocale:'en',locales:{en:'Research','zh-Hant':'研究產業','zh-TW':{fallback:'zh-Hant'}}},
  description:{original:'稳定说明',defaultLocale:'en',locales:{en:'Stable description'}},
 }}
 assert.deepEqual(localizedIndustryTemplateMetadata(manifest,'zh-TW'),{
  title:{value:'研究產業',locale:'zh-Hant'},description:{value:'Stable description',locale:'en'},
 })
 assert.deepEqual(localizedIndustryTemplateMetadata({title:'研究行业',description:'稳定说明'},'de-DE'),{
  title:{value:'研究行业',locale:null},description:{value:'稳定说明',locale:null},
 })
 assert.deepEqual({title:manifest.title,description:manifest.description},{title:'研究行业',description:'稳定说明'})
})

test('行业资源标题按界面 locale 解析，缺少目标语言时回退英文且不翻译正文',()=>{
 const resource={id:'guide',kind:'knowledge' as const,title:'调查手册',version:'1.0.0',required:true,source:{kind:'local' as const,path:'knowledge/guide.md'},localized:{title:{original:'调查手册',defaultLocale:'en',locales:{en:'Investigation guide','zh-CN':'调查手册','zh-Hant':'調查手冊'}}}}
 assert.equal(localizedIndustryResourceTitle(resource,'zh-HK'),'調查手冊')
 assert.equal(localizedIndustryResourceTitle(resource,'de'),'Investigation guide')
 assert.equal(localizedIndustryResourceTitle({title:resource.title},'en'),'调查手册')
})
