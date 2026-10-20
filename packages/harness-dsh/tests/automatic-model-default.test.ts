import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import {configuredModelDefault,createAutomaticModelDefault} from '../src/automatic-model-default.ts'
import type {ModelCatalogReadiness} from '../src/model-catalog-readiness.ts'

const selected={provider:'minimax',model:'MiniMax-M2.7'}
const state=():ModelCatalogReadiness=>({catalog:{default:{provider:'deepseek-official',model:'deepseek-v4-pro'},groups:[{id:'deepseek-official',name:'DeepSeek',models:[{id:'deepseek-v4-pro',name:'DS'}]},{id:'minimax',name:'MiniMax',models:[{id:selected.model,name:selected.model}]}],routableProviders:['deepseek-official','minimax'],failures:[]},missingCredentialProviders:['deepseek-official'],configuredCredentialProviders:['minimax']})

test('首次只配置 MiniMax 时替代缺凭据的内建默认；有效默认、未知凭据、多提供商均不擅自换路由',()=>{
 assert.deepEqual(configuredModelDefault(state()),selected)
 const valid=state();assert.equal(configuredModelDefault({...valid,catalog:{...valid.catalog,default:selected}}),undefined)
 const unknown=state();unknown.missingCredentialProviders=[];assert.equal(configuredModelDefault(unknown),undefined)
 const multiple=state();assert.equal(configuredModelDefault({...multiple,configuredCredentialProviders:['minimax','other'],catalog:{...multiple.catalog,groups:[...multiple.catalog.groups,{id:'other',name:'Other',models:[{id:'m',name:'M'}]}],routableProviders:[...multiple.catalog.routableProviders,'other']}}),undefined)
 const absent=state();absent.configuredCredentialProviders=[];assert.equal(configuredModelDefault(absent),undefined)
})

test('新增模型自动保存默认并同步未发送草稿，保留显式选模、已有历史、子会话和任务；不发请求',async()=>{
 let current=state().catalog.default,saved=0
 const changes:string[]=[],listeners=new Map<string,()=>void>()
 const agent=(id:string,events:unknown[]=[],pending:unknown=null,origin?:string)=>({id,status:'idle',pending,session:{id,header:{origin},snapshotEvents:()=>events}})
 const agents=[agent('blank'),agent('explicit',[],selected),agent('used',[{seq:0,type:'request/header',data:{}}]),agent('sub',[],null,'subagent'),agent('task-run-fixed'),agent('group-routing-fixed')]
 const ctx={agentDefaultModel:{currentSelection:()=>current,saveSelection:async(value:typeof current)=>{current=value;saved++}},agents:{list:()=>agents},sessionController:{selectModel:async(value:{sessionId:string})=>{changes.push(value.sessionId)}},sessionProjections:{stateOf:(session:{id:string})=>({pending:agents.find(agent=>agent.id===session.id)!.pending})},on:(event:string,listener:()=>void)=>{listeners.set(event,listener);return()=>listeners.delete(event)},logger:{warn:()=>{}}} as unknown as Context
 const runtime=createAutomaticModelDefault(ctx,{read:async()=>({...state(),catalog:{...state().catalog,default:current}})})
 await runtime.refresh()
 assert.deepEqual(current,selected);assert.equal(saved,1);assert.deepEqual(changes,['blank'])
 await runtime.refresh();assert.equal(saved,1)
 runtime.dispose();assert.equal(listeners.size,0)
})

test('读取配置时本人另选默认，迟到的自动初始化不得覆盖',async()=>{
 const old=state(),manual={provider:'manual',model:'chosen'}
 let current=old.catalog.default,saves=0
 const ctx={agentDefaultModel:{currentSelection:()=>current,saveSelection:async()=>{saves++}},on:()=>()=>{},logger:{warn:()=>{}}} as unknown as Context
 const runtime=createAutomaticModelDefault(ctx,{read:async()=>{current=manual;return old}})
 await runtime.refresh();assert.equal(saves,0);assert.deepEqual(current,manual);runtime.dispose()
})
