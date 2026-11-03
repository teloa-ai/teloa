import test from 'node:test'
import assert from 'node:assert/strict'
import {watchCitationActivation,type CitationActivationState} from '../src/client/citation-activation.ts'
const tick=()=>new Promise<void>(r=>setImmediate(r))
test('返回来源页立即隐藏旧正文，重验撤回、隐藏、晚答及取消',async()=>{
 const focus=new EventTarget(),visibility=new EventTarget(),states:CitationActivationState<string>[]=[],pending:{resolve:(v:string)=>void;signal:AbortSignal}[]=[]
 let visible=true,current=true
 const dispose=watchCitationActivation({focus,visibility,visible:()=>visible,current:()=>current,read:signal=>new Promise<string>(resolve=>pending.push({resolve,signal})),publish:value=>states.push(value)})
 assert.equal(states.at(-1)?.status,'loading');await tick();pending[0]!.resolve('原文');await tick();assert.deepEqual(states.at(-1),{status:'ready',value:'原文'})
 focus.dispatchEvent(new Event('focus'));assert.equal(states.at(-1)?.status,'loading');await tick()
 visible=false;visibility.dispatchEvent(new Event('visibilitychange'));assert.equal(states.at(-1)?.status,'unavailable');assert.equal(pending[1]!.signal.aborted,true)
 pending[1]!.resolve('过期晚答');await tick();assert.equal(states.at(-1)?.status,'unavailable')
 visible=true;focus.dispatchEvent(new Event('focus'));await tick();current=false;pending[2]!.resolve('已撤权');await tick();assert.equal(states.at(-1)?.status,'unavailable')
 current=true;focus.dispatchEvent(new Event('focus'));await tick();dispose();assert.equal(pending[3]!.signal.aborted,true);const count=states.length;pending[3]!.resolve('卸载晚答');await tick();focus.dispatchEvent(new Event('focus'));assert.equal(states.length,count)
})
