import test from 'node:test'
import assert from 'node:assert/strict'
import {createPlanBusinessSources} from '../src/client/plan-work-business-sources.ts'

const scope='support'
const current={scope,version:2,manifest:{format:'teloa.business-configuration/v2',scope,title:'售后',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',localId:'tickets',version:2,definitionHash:'a'.repeat(64)}],pages:[{kind:'records',id:'tickets-page',title:'售后工单',objectType:'tickets',fields:['amount'],allowCreate:true,allowEdit:true,allowArchive:true}]},hash:'b'.repeat(64),createdAt:'2026-10-25T00:00:00.000Z'} as const
const unusedLedger={read:async()=>{throw Error('富字段配置不应读取旧台账')}}
test('富字段正式配置直接提供本业务记录类型，重复视图不产生重复来源',async()=>{
 const requests:unknown[]=[]
 const api=createPlanBusinessSources({current:async input=>{requests.push(input);return {...current,manifest:{...current.manifest,pages:[...current.manifest.pages,{...current.manifest.pages[0],id:'second-page'}]}} as any}},unusedLedger)
 assert.deepEqual(await api.list(scope),[{sourceRef:{kind:'business-object-type',scope:'support',type:'tickets'},title:'售后工单'}])
 assert.deepEqual(requests,[{scope:'support'}])
})
test('只有明确无正式配置时读取原业务旧台账来源',async()=>{
 const requests:unknown[]=[]
 const api=createPlanBusinessSources({current:async()=>null},{read:async input=>{requests.push(input);return {scope,blocks:[{objectType:{definition:{id:'orders',domain:scope,title:'订单'}}}]} as any}})
 assert.deepEqual(await api.list(scope),[{sourceRef:{kind:'business-object-type',scope:'support',type:'orders'},title:'订单'}])
 assert.deepEqual(requests,[{scope:'support'}])
})
test('业务配置不可读或权限撤回不能被旧台账回退吞掉',async()=>{
 const failure=Object.assign(Error('来源已撤回'),{code:'teloa/source-unavailable'}),api=createPlanBusinessSources({current:async()=>{throw failure}},unusedLedger)
 await assert.rejects(api.list(scope),error=>error===failure)
})
test('跨业务回包或未登记类型不能成为可选择来源',async()=>{
 await assert.rejects(createPlanBusinessSources({current:async()=>({...current,scope:'foreign'}) as any},unusedLedger).list(scope))
 await assert.rejects(createPlanBusinessSources({current:async()=>({...current,manifest:{...current.manifest,definitions:[]}}) as any},unusedLedger).list(scope))
 await assert.rejects(createPlanBusinessSources({current:async()=>null},{read:async()=>({scope:'foreign',blocks:[]}) as any}).list(scope))
})
test('通用工作不访问业务来源，明确空配置不查询旧台账',async()=>{
 const api=createPlanBusinessSources({current:async()=>({...current,manifest:{...current.manifest,pages:[],definitions:[]}}) as any},unusedLedger)
 assert.deepEqual(await api.list(scope),[])
 await assert.rejects(api.list('general'))
})
test('已登记但没有记录页的类型仍然有效，不能误当成来源已撤回',async()=>{
 const api=createPlanBusinessSources({current:async()=>({...current,manifest:{...current.manifest,pages:[]}}) as any},unusedLedger)
 assert.deepEqual(await api.list(scope),[{sourceRef:{kind:'business-object-type',scope:'support',type:'tickets'}}])
})
