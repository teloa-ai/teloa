import test from 'node:test'
import assert from 'node:assert/strict'
import {BusinessDataService} from '../src/work/business-data.ts'
test('真实业务查询服务区分主体越权与当前业务无来源，两条失败路径均不访问HTTP或数据库',async()=>{
 let sourceCalls=0,databaseCalls=0
 const pool={connect:async()=>{databaseCalls++;throw Error('no database call expected')}}
 const service=new BusinessDataService(pool,{id:'security-alert-http',scopes:['SOC'],query:async()=>{sourceCalls++;throw Error('no HTTP/source call expected')}})
 await assert.rejects(service.query({ownerId:'owner',scopeIds:['SOC']},{scope:'AppSec',limit:10}),{code:'teloa/forbidden',message:'当前主体未获准读取此业务范围。'})
 await assert.rejects(service.query({ownerId:'owner',scopeIds:['AppSec']},{scope:'AppSec',limit:10}),{code:'teloa/source-unavailable',message:'当前业务尚未连接可查询的数据源。'})
 assert.equal(sourceCalls,0);assert.equal(databaseCalls,0)
})
