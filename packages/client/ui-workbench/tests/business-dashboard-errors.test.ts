import test from 'node:test'
import assert from 'node:assert/strict'
import {businessDashboardErrorKey} from '../src/client/business-dashboard-errors.ts'

test('组件/看板错误码 + reason → 固定词条键：九类各一，只有 SQL 那句带 reason',()=>{
 const cases:Array<[string,string,{key:string;params?:Record<string,string>}]>=[
  ['teloa/dependency-unavailable','查询超过 5 秒已中止',{key:'business.dashboards.error.timeout'}],
  ['teloa/dependency-unavailable','查询排队超时',{key:'business.dashboards.error.queue'}],
  ['teloa/invalid-input','结果超过 10 000 行',{key:'business.dashboards.error.rows'}],
  ['teloa/invalid-input','结果超过 8 MB',{key:'business.dashboards.error.resultBytes'}],
  ['teloa/invalid-input','单行超过 1 MB',{key:'business.dashboards.error.rowBytes'}],
  ['teloa/invalid-input','不允许的函数 pg_sleep',{key:'business.dashboards.error.sql',params:{reason:'不允许的函数 pg_sleep'}}],
  ['teloa/source-unavailable','数据源待配置凭据',{key:'business.dashboards.error.credentials'}],
  ['teloa/source-unavailable','数据源暂不可读。',{key:'business.dashboards.error.source'}],
  ['teloa/forbidden','当前主体未获准读取此业务范围。',{key:'business.dashboards.error.forbidden'}],
  ['teloa/storage-corrupt','固定业务对象快照格式不正确。',{key:'business.dashboards.error.corrupt'}],
  ['teloa/conflict','看板正在刷新',{key:'business.dashboards.error.conflict'}],
  ['teloa/version-conflict','版本已变化',{key:'business.custom.conflict'}],
 ]
 for(const [code,reason,expected] of cases)assert.deepEqual(businessDashboardErrorKey({code:code as never,reason}),expected,code+' '+reason)
})

test('认不出的错误码或原因一律回落通用句，原文不上屏',()=>{
 assert.deepEqual(businessDashboardErrorKey({code:'teloa/unknown-code' as never,reason:'内部细节'}),{key:'business.dashboards.widget.failed'})
 assert.deepEqual(businessDashboardErrorKey({code:'teloa/dependency-unavailable',reason:'数据库暂不可用'}),{key:'business.dashboards.widget.failed'})
 assert.deepEqual(businessDashboardErrorKey({code:'teloa/invalid-input',reason:''}),{key:'business.dashboards.widget.failed'})
 assert.equal(businessDashboardErrorKey({code:'teloa/invalid-input',reason:'x'.repeat(500)}).params?.reason.length,200)
})
