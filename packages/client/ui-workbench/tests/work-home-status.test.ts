import assert from 'node:assert/strict'
import test from 'node:test'
import {attentionStatusText,planStatusText} from '../src/client/work-home-status.ts'

const planMessages:Record<string,string>={
  'continuous.rolePlans.count':'{count} saved plans',
  'attention.persistence.example':'Example',
  'navigation.plans':'Plans',
  'continuous.detail.runs':'Runs · {count}',
  'continuous.saved.description':'Saved plan runs are checked in plan details',
  'continuous.empty.plans':'No continuous plans yet',
  'continuous.loading':'Loading plans…',
  'continuous.loading.retry':'Retry loading plans',
}
const planT=(key:string,values?:Readonly<Record<string,string|number>>)=>(planMessages[key]??key).replace('{count}',String(values?.count??''))

test('首页待办状态只说明统一正式待处理数量',()=>{
  const t=(key:string,values?:Record<string,unknown>)=>key==='home.attentionCount'?`${values?.count} items need you`:key
  assert.equal(attentionStatusText({count:3,known:true},t),'3 items need you')
  assert.equal(attentionStatusText({count:0,known:true},t),'0 items need you')
})

test('真实待办仍在读取时不会把当前数字冒充完整结果',()=>{
  const calls:string[]=[]
  const t=(key:string)=>{calls.push(key);return key==='attention.home.checking'?'Checking saved items':key}
  assert.equal(attentionStatusText({count:1,known:false},t),'Checking saved items')
  assert.deepEqual(calls,['attention.home.checking'])
})

test('首页持续工作分别说明已保存计划、示例计划与示例执行',()=>{
  assert.equal(planStatusText({savedPlans:2,examplePlans:1,exampleRuns:4,directory:'ready'},planT),'2 saved plans · 1 · Example · Plans · Example · Runs · 4')
  assert.equal(planStatusText({savedPlans:2,examplePlans:0,exampleRuns:0,directory:'ready'},planT),'2 saved plans · Saved plan runs are checked in plan details')
  assert.equal(planStatusText({savedPlans:0,examplePlans:0,exampleRuns:0,directory:'ready'},planT),'No continuous plans yet')
})

test('持续计划目录尚未确认时不把零条冒充真实空目录',()=>{
  assert.equal(planStatusText({savedPlans:0,examplePlans:0,exampleRuns:0,directory:'loading'},planT),'Loading plans…')
  assert.equal(planStatusText({savedPlans:0,examplePlans:1,exampleRuns:0,directory:'failed'},planT),'1 · Example · Plans · Retry loading plans')
})
