import test from 'node:test'
import assert from 'node:assert/strict'
import {methodReuseBasisHash} from '@teloa/contract'
import {planMethodSourceNotice,readRunPlanContext,runPlanContextHash} from '../src/work/task-run-plan-context.ts'

const context={occurrenceId:'20000000-0000-4000-8000-000000000001',goal:'按原成果整理行动单',dataScope:'仅原合成资料',delivery:'完整Markdown'}
const source={kind:'session' as const,id:'original',scope:'general',version:'4',title:'原成果'}
const content={title:'周会行动单',sections:[{id:'actions',title:'行动清单',text:'小林回访截止22日；阿文预算复核截止21日。'},{id:'risk',title:'风险与下一步',text:'总12000，已支出4500，剩余7500；实际完成状态未知。'}],snapshotIds:[],note:'合成资料，不授予权限'}

test('计划固定来源全文进入原context hash，正文篡改、缺失或额外授权字段拒绝',async()=>{
 const methodSource={artifactId:'30000000-0000-4000-8000-000000000001',version:4,basisHash:await methodReuseBasisHash({source,content}),source,content,notice:planMethodSourceNotice}
 const input={...context,methodSource},fixed=readRunPlanContext(input)!
 assert.deepEqual(fixed.methodSource?.content,content)
 assert.equal(fixed.methodSource?.version,4)
 assert.notEqual(runPlanContextHash(fixed),runPlanContextHash(context))
 for(const altered of [
  {...methodSource,content:{...content,sections:[{...content.sections[0]!,text:'伪造原事实'}]}},
  {...methodSource,content:undefined},
  {...methodSource,notice:'来源即授权'},
  {...methodSource,allowedTools:['shell']},
 ])assert.throws(()=>readRunPlanContext({...context,methodSource:altered}),{code:'teloa/storage-corrupt'})
})

test('旧计划历史没有来源快照时仍按原结构读取，不补写或改变历史hash',()=>{
 const old=JSON.stringify(context),fixed=readRunPlanContext(JSON.parse(old))!
 assert.deepEqual(fixed,context)
 assert.equal(Object.hasOwn(fixed,'methodSource'),false)
 assert.equal(JSON.stringify(context),old)
 assert.equal(runPlanContextHash(fixed),runPlanContextHash(JSON.parse(old)))
})
