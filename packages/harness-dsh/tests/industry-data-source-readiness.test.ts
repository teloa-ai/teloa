import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndustryDataSourceReadiness} from '../src/industry-data-source-readiness.ts'

const definition={format:'teloa.data-source/v1' as const,sourceId:'security-alert-http',scopes:['SOC']}
const fallback='2026-01-01T00:00:00.000Z'
const port=(overrides:Partial<{id:string;scopes:string[];ready:boolean;reason:string;probedAt:unknown}>={})=>{
 const calls:Array<{scope:string;signal:AbortSignal}>=[]
 return {calls,port:{id:overrides.id??'security-alert-http',scopes:overrides.scopes??['SOC'],query:async()=>({}),ready:async(scope:string,signal:AbortSignal)=>{calls.push({scope,signal});return overrides.ready===false?{ready:false as const,reason:overrides.reason??'offline'}:{ready:true as const,probedAt:('probedAt' in overrides?overrides.probedAt:'2026-09-14T00:00:00.000Z') as string}}}}
}

test('匹配端口且范围覆盖时探测并透传端口的 probedAt 与信号',async()=>{
 const p=port(),signal=new AbortController().signal,readiness=createIndustryDataSourceReadiness([p.port],()=>fallback)
 assert.deepEqual(await readiness.ready(definition,'SOC',signal),{ready:true,probedAt:'2026-09-14T00:00:00.000Z'})
 assert.deepEqual(p.calls,[{scope:'SOC',signal}])
 assert.equal(p.calls[0]!.signal,signal)
})

test('端口 probedAt 规范化为严格 ISO，非法值回落 now()',async()=>{
 const offset=port({probedAt:'2026-09-14T00:00:00+00:00'})
 assert.deepEqual(await createIndustryDataSourceReadiness([offset.port],()=>fallback).ready(definition,'SOC',new AbortController().signal),{ready:true,probedAt:'2026-09-14T00:00:00.000Z'})
 const missing=port({probedAt:undefined})
 assert.deepEqual(await createIndustryDataSourceReadiness([missing.port],()=>fallback).ready(definition,'SOC',new AbortController().signal),{ready:true,probedAt:fallback})
 const unparsable=port({probedAt:'昨天'})
 assert.deepEqual(await createIndustryDataSourceReadiness([unparsable.port],()=>fallback).ready(definition,'SOC',new AbortController().signal),{ready:true,probedAt:fallback})
})

test('未注册端口、范围不覆盖或探测失败都返回明确原因且不抛异常',async()=>{
 const missing=createIndustryDataSourceReadiness([],()=>fallback)
 assert.deepEqual(await missing.ready(definition,'SOC',new AbortController().signal),{ready:false,reason:'宿主未注册数据源 security-alert-http'})
 const narrow=port({scopes:['AppSec']})
 assert.deepEqual(await createIndustryDataSourceReadiness([narrow.port],()=>fallback).ready(definition,'SOC',new AbortController().signal),{ready:false,reason:'数据源 security-alert-http 不覆盖范围 SOC'})
 assert.deepEqual(narrow.calls,[])
 const offline=port({ready:false,reason:'配置不可读取'})
 assert.deepEqual(await createIndustryDataSourceReadiness([offline.port],()=>fallback).ready(definition,'SOC',new AbortController().signal),{ready:false,reason:'配置不可读取'})
})

test('已取消的信号直接抛出且不探测',async()=>{
 const p=port(),controller=new AbortController();controller.abort()
 await assert.rejects(createIndustryDataSourceReadiness([p.port],()=>fallback).ready(definition,'SOC',controller.signal))
 assert.deepEqual(p.calls,[])
})
