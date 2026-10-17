import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {createEntityNameKey,createNextKey,createPlaceholderKey,createSentencePrompt,createPlanPreview} from '../src/client/page-create-presentation.ts'

registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {translateMessage}=await import('../src/client/i18n/messages.ts')

test('计划草稿复用 Markdown 创建说明，三语名称与下一步可读且原说明完整保留',()=>{
 const description='# 每日客户摘要\n每天整理我提供的反馈；事实不足时写待确认。\n先保存，不启用。'
 for(const locale of ['zh-CN','zh-Hant','en'] as const){
  const t=(...args:Parameters<Parameters<typeof createSentencePrompt>[3]>)=>translateMessage(locale,...args)
  for(const key of [createEntityNameKey('plan'),createNextKey('plan'),createPlaceholderKey('plan')]){
   assert.equal(typeof key,'string','计划应有正式创建词条，不能落空')
   assert.notEqual(t(key),key)
  }
  const prompt=createSentencePrompt('plan',undefined,description,t)
  assert.equal(prompt.sourceId,'plan:')
  assert.ok(prompt.text.endsWith(description),'创建器不能拆散或改写本人 Markdown 说明')
  assert.ok(prompt.text.includes(t(createEntityNameKey('plan'))))
 }
})

test('计划紧凑摘要读取完整正式正文，不依赖已截断字段表，也不改写采用依据',async()=>{
 const {readPageCreatePlanDraft,pageCreateFieldRows,pageCreateCanonicalBody}=await import('@teloa/contract')
 const schedule={kind:'schedule',cadence:'weekly',weekday:2,time:'14:25',timezone:'Asia/Singapore'}
 const raw={definition:{executor:{kind:'owner'},roleId:null,title:'本人每周核对',goal:'完整原目标',scope:'general',dataScope:'原资料范围',delivery:'原交付要求',trigger:schedule,notificationPolicy:'failure'},work:{completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:9,maxTokens:123456,maxElapsedMs:65000,maxConcurrent:2,maxRetries:3,stagnationRounds:4,money:null},overlap:'independent',missed:'coalesce',safeRecovery:true},intent:'save-paused',source:{artifactId:'20000000-0000-4000-8000-000000000001',version:2,basisHash:'e'.repeat(64)}}
 const body=pageCreateCanonicalBody(readPageCreatePlanDraft(raw)),allFields=pageCreateFieldRows(JSON.parse(body)),before=JSON.stringify(raw)
 assert.ok(allFields.some(row=>row.path==='source.basisHash'))
 // 实际服务截断的是字段表，正式完整正文仍在；不能把fieldsTruncated当成隐去预算的理由。
 const preview={draft:{entity:'plan',body},fields:allFields.slice(0,2),fieldsTruncated:true,consequences:[]} as any
 for(const locale of ['zh-CN','zh-Hant','en'] as const){
  const t=(...args:Parameters<Parameters<typeof createSentencePrompt>[3]>)=>translateMessage(locale,...args)
  const summary=createPlanPreview(preview,t),text=JSON.stringify(summary.fields)
  for(const value of ['完整原目标','原资料范围','原交付要求','123456','65','14:25','Asia/Singapore'])assert.ok(text.includes(value),value)
  assert.doesNotMatch(text,/source.basisHash|work.budget|create.plan.preview\.|eeeeeeee|20000000/)
  assert.ok(summary.consequences.length>=3)
  assert.ok(summary.references.some(row=>row.value.includes(raw.source.artifactId)&&row.value.includes('2')))
  assert.ok(summary.references.some(row=>row.value===raw.source.basisHash))
  const configured=createPlanPreview({...preview,draft:{entity:'plan',body:JSON.stringify({kind:'configure-work',planId:raw.source.artifactId,expectedVersion:7,expectedConfigVersion:5,work:raw.work,intent:'save-paused'})}},t)
  assert.ok(configured.references.some(row=>row.value===raw.source.artifactId))
  assert.ok(configured.references.some(row=>row.value.includes('7')&&row.value.includes('5')))

 }
 assert.equal(preview.draft.body,body);assert.equal(JSON.stringify(raw),before)
 assert.throws(()=>createPlanPreview({...preview,draft:{entity:'plan',body:JSON.stringify({...raw,unexpected:true})}},()=>''),'无效正式正文不能回退成可确认的技术字段')
})
