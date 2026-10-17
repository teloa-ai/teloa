import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {readBusinessConfigurationCandidateVersioned} from '../src/business-configuration-v2.ts'
import {readBusinessObjectTypeDefinition,readBusinessViewDefinition} from '../src/business-definitions.ts'
import {readBusinessSourceMappingDefinition} from '../src/business-source-mapping.ts'
import {readBusinessWidgetDefinition,readBusinessDashboardDefinition} from '../src/business-dashboards.ts'

const path=new URL('../../../examples/business/ai-soc-configuration.json',import.meta.url)
const load=()=>{
 const candidate=readBusinessConfigurationCandidateVersioned(JSON.parse(readFileSync(path,'utf8')))
 // v1 候选的 kind 与 definition 类型没有绑定；按真实 kind 再解析，保留模板验证并建立可收窄联合体。
 const definitions=candidate.definitions.map(item=>{
  switch(item.kind){
   case 'object-type':return {kind:item.kind,definition:readBusinessObjectTypeDefinition(item.definition)}
   case 'view':return {kind:item.kind,definition:readBusinessViewDefinition(item.definition)}
   case 'source-mapping':return {kind:item.kind,definition:readBusinessSourceMappingDefinition(item.definition)}
   case 'widget':return {kind:item.kind,definition:readBusinessWidgetDefinition(item.definition)}
   case 'dashboard':return {kind:item.kind,definition:readBusinessDashboardDefinition(item.definition)}
  }
 })
 return {...candidate,definitions}
}

test('AI SOC 模板可由通用业务配置读取，五类对象与六个看板完整绑定',()=>{
 assert.ok(existsSync(path),'缺少可安装的 AI SOC 业务配置模板')
 const candidate=load()
 const objects=candidate.definitions.filter(item=>item.kind==='object-type')
 assert.deepEqual(objects.map(item=>item.definition.id),['ai-soc-work-item','ai-soc-alert','ai-soc-incident','ai-soc-hunt','ai-soc-response','ai-soc-detection'])
 const ids=new Set(candidate.definitions.map(item=>item.definition.id))
 assert.equal(candidate.definitions.filter(item=>item.kind==='dashboard').length,6)
 assert.equal(candidate.pages.length,12)
 for(const item of candidate.definitions){
  const definition=item.definition
  if(item.kind==='view')assert.ok(ids.has(item.definition.objectType))
  if(item.kind==='widget')assert.ok(ids.has(item.definition.viewRef!))
  if(item.kind==='dashboard')for(const widget of item.definition.widgets)assert.ok(ids.has(widget))
  assert.equal(definition.domain,candidate.scope)
 }
 for(const object of objects.filter(item=>item.definition.id!=='ai-soc-work-item')){
  const mapping=candidate.definitions.find(item=>item.kind==='source-mapping'&&item.definition.objectType===object.definition.id)
  assert.ok(mapping&&mapping.kind==='source-mapping')
  assert.equal(mapping.definition.source.kind,'role-result')
  assert.deepEqual(mapping.definition.primaryKey,['object_id'],'按业务对象去重，不能按会话或结果版本重复计数')
  assert.deepEqual(mapping.definition.mapping.find(field=>field.field==='employee'),{path:'$.employee.id',field:'employee'})
  assert.deepEqual(mapping.definition.mapping.find(field=>field.field==='source_task'),{path:'$.task.id',field:'source_task'})
  for(const target of mapping.definition.mapping)assert.ok(['title','summary','observedAt',...object.definition.fields.map(field=>field.name)].includes(target.field))
 }
})

test('员工处理状态独立于业务生命周期，核验与关闭不能用 AI 已完成代替',()=>{
 const candidate=load()
 for(const type of ['ai-soc-incident','ai-soc-response']){
  const object=candidate.definitions.find(item=>item.kind==='object-type'&&item.definition.id===type)
  assert.ok(object&&object.kind==='object-type')
  assert.notDeepEqual(object.definition.fields.find(field=>field.name==='lifecycle')?.values,object.definition.fields.find(field=>field.name==='work_status')?.values)
  const active=candidate.definitions.find(item=>item.kind==='view'&&item.definition.id===type+'-active')
  assert.ok(active&&active.kind==='view')
  assert.equal(active.definition.filters[0]?.field,'lifecycle')
  assert.equal(active.definition.filters[0]?.op,'in')
  assert.ok(!active.definition.filters[0]?.values.includes(type==='ai-soc-incident'?'已关闭':'已核验'))
  if(type==='ai-soc-response')assert.ok(active.definition.filters[0]?.values.includes('已批准'),'动作受理仍是未核验响应')
 }
})

test('时效只统计已完成员工工作，缺失时长保持可识别，不声明未经验证的准确率和覆盖率',()=>{
 const candidate=load()
 for(const object of candidate.definitions.filter(item=>item.kind==='object-type').filter(item=>item.definition.id!=='ai-soc-work-item')){
  assert.equal(object.definition.fields.find(field=>field.name==='duration')?.required,false)
  const latency=candidate.definitions.find(item=>item.kind==='view'&&item.definition.id===object.definition.id+'-latency')
  assert.ok(latency&&latency.kind==='view')
  assert.deepEqual(latency.definition.measures,[{id:'value',label:'平均耗时',aggregation:'avg',field:'duration'}])
  assert.deepEqual(latency.definition.filters,[{field:'work_status',op:'eq',values:['已完成']}])
 }
 assert.doesNotMatch(candidate.definitions.map(item=>item.definition.title).join('\n'),/准确率|覆盖率|节省成本/)
})
