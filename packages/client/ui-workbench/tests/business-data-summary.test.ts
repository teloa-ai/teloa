import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeBusinessSources } from '../src/client/business-data-summary.ts'
import type { BusinessObject } from '../src/client/business-preview.ts'

const object=(overrides:Partial<BusinessObject>):BusinessObject=>({
  scope:'SOC',type:'alert',typeTitle:'告警',id:'evt-1',version:1,title:'异常行为',source:'EDR',
  observedAt:'2026-09-12T08:00:00.000Z',receivedAt:'2026-09-12T08:01:00.000Z',
  quality:'complete',summary:'示例对象',fields:[],...overrides,
})

test('按当前业务汇总来源、最新接入时间与待补齐对象',()=>{
  const rows=summarizeBusinessSources([
    object({id:'evt-1',source:'EDR',type:'alert',receivedAt:'2026-09-12T08:01:00.000Z'}),
    object({id:'evt-2',source:'EDR',type:'asset',quality:'missing',receivedAt:'2026-09-12T08:06:00.000Z'}),
    object({id:'repo-1',scope:'AppSec',source:'GitHub',type:'repository',receivedAt:'2026-09-12T08:09:00.000Z'}),
  ],'SOC','zh-CN')

  assert.deepEqual(rows,[{
    source:'EDR',total:2,missing:1,latestReceivedAt:'2026-09-12T08:06:00.000Z',types:['alert','asset'],
  }])
})

test('没有当前业务对象时不生成虚构来源状态',()=>{
  assert.deepEqual(summarizeBusinessSources([object({scope:'Design'})],'SOC','zh-CN'),[])
})

test('数据来源按当前界面语言排序',()=>{
  const rows=summarizeBusinessSources([
    object({id:'source-zh',source:'张'}),
    object({id:'source-en',source:'Apple'}),
  ],'SOC','en')
  assert.deepEqual(rows.map(row=>row.source),['Apple','张'])
})
