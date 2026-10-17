import test from 'node:test'
import assert from 'node:assert/strict'
import type {SubagentRuntime,SubagentActivationSpec} from '@deepseek-ai/dsh-subagent'
import {createActivationAdmissionRuntime,installActivationAdmission} from '../src/subagent-activation-admission.ts'

function fixture(){
 let starts=0
 class Native{
  getProvider(name:string){return name==='spawn'?{prepareContinuable(){}}:{start(){}}}
  async startActivation(){starts++;return {childId:'native',result:Promise.resolve({output:[],stopReason:'completed'}),dispose:async()=>{}}}
 }
 const Runtime=createActivationAdmissionRuntime(Native as unknown as typeof SubagentRuntime),runtime=new Runtime({} as never,{} as never)
 const spec=(provider:string)=>({provider,delivery:'parent',request:{parent:{}},signal:new AbortController().signal,label:'fixture'}) as SubagentActivationSpec
 return {runtime,spec,starts:()=>starts}
}

test('外部 activation 在业务守卫尚未安装或卸载后拒绝，本地运行继续复用原生',async()=>{
 const f=fixture()
 await assert.rejects(async()=>f.runtime.startActivation(f.spec('codex')),/外部/)
 assert.equal(f.starts(),0)
 await f.runtime.startActivation(f.spec('spawn'));assert.equal(f.starts(),1)
 const remove=installActivationAdmission(f.runtime,async(spec,start)=>start(spec),'external')
 await f.runtime.startActivation(f.spec('codex'));assert.equal(f.starts(),2)
 remove();await assert.rejects(async()=>f.runtime.startActivation(f.spec('codex')),/外部/)
 assert.equal(f.starts(),2)
})

test('编排与外部准入在一个受理点组合，scoped receiver保持同一不可替换holder',async()=>{
 const f=fixture(),calls:string[]=[]
 installActivationAdmission(f.runtime,async(spec,start)=>{calls.push('local');return start(spec)})
 installActivationAdmission(f.runtime,async(spec,start)=>{calls.push('external');return start(spec)},'external')
 const scoped=Object.create(f.runtime) as typeof f.runtime
 await scoped.startActivation(f.spec('codex'))
 assert.deepEqual(calls,['local','external']);assert.equal(f.starts(),1)
 assert.throws(()=>installActivationAdmission(f.runtime,async(spec,start)=>start(spec),'external'),/重复/)
})
