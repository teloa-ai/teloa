import test from 'node:test'
import assert from 'node:assert/strict'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {leaseRunTools} from '../src/task-run-tool-lease.ts'
import {registerTaskRunTextScope} from '../src/task-run-text-scope.ts'

function fixture(id='native-session'){
 const events:SessionEvent[]=[]
 const state={status:'idle' as Agent['status']},agent={id,get status(){return state.status},session:{snapshotEvents:()=>events}} as unknown as Agent
 const accept=(rpcId:string)=>events.push({seq:events.length,type:'turn/start',data:{turn:0}} as SessionEvent,{seq:events.length+1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId}}} as SessionEvent)
 const end=()=>events.push({seq:events.length,type:'turn/end',data:{turn:0}} as SessionEvent)
 return {agent,accept,end,setStatus:(status:Agent['status'])=>{state.status=status}}
}
test('text租约只绑定当前Agent；派发前可释放，派发后普通清理不能移除守卫',()=>{
 const a=fixture(),b=fixture();let installedA=0,releasedA=0,installedB=0
 const before=leaseRunTools(a.agent,'before',true,()=>{installedA++;return ()=>{releasedA++}});before()
 assert.equal(releasedA,1)
 const active=leaseRunTools(a.agent,'A',true,()=>{installedA++;return ()=>{releasedA++}})
 leaseRunTools(b.agent,'B',false,()=>{installedB++;return ()=>{installedB--}})
 a.accept('A');active();assert.equal(releasedA,1);assert.equal(installedB,1)
 leaseRunTools(a.agent,'A',true,()=>{throw Error('同Run不能重复安装')})
 assert.throws(()=>leaseRunTools(a.agent,'A',false,()=>()=>{}),/同一运行不能替换/)
 assert.equal(installedA,2)
})
test('在途text不能被下一Run撤回；真实turn/end且idle后不同显式授权可替换，旧disposer不影响新Run',()=>{
 const x=fixture();let restricted=true,released=0
 const old=leaseRunTools(x.agent,'original',true,()=>()=>{restricted=false;released++})
 x.accept('original');assert.throws(()=>leaseRunTools(x.agent,'next',false,()=>()=>{}),/尚未结束/);assert.equal(restricted,true)
 x.end();x.setStatus('running');assert.throws(()=>leaseRunTools(x.agent,'next',false,()=>()=>{}),/尚未结束/)
 x.setStatus('idle');let nextReleased=0
 const next=leaseRunTools(x.agent,'next',false,()=>()=>{nextReleased++})
 assert.equal(released,1);old();assert.equal(nextReleased,0);next();assert.equal(nextReleased,1)
})
test('冷恢复在最终组装前按持久Run恢复text；普通会话目录不受影响，缺身份保守拒绝',async()=>{
 const x=fixture(),sibling=fixture('sibling')
 let hook:Function|undefined,installs=0
 const ctx={on:(_event:string,callback:Function)=>{hook=callback;return ()=>{}},agents:{get:(id:string)=>id===x.agent.id?x.agent:id===sibling.agent.id?sibling.agent:undefined}} as unknown as Context
 let nativeRequestId:string|undefined='original'
 registerTaskRunTextScope(ctx,async id=>id===x.agent.id?{allowedTools:[],textOnly:true,...(nativeRequestId===undefined?{}:{nativeRequestId})}:null,()=>{installs++;return ()=>{}})
 const next=async()=>({tools:[{name:'bash'}],sections:[],contexts:[]})
 assert.deepEqual((await hook!({}, {scope:sibling.agent},next)).tools,[{name:'bash'}]);assert.equal(installs,0)
 assert.deepEqual((await hook!({}, {scope:x.agent},next)).tools,[]);assert.equal(installs,1)
 assert.deepEqual((await hook!({}, {scope:x.agent},next)).tools,[]);assert.equal(installs,1)
 nativeRequestId=undefined;await assert.rejects(hook!({}, {scope:x.agent},next),/缺少固定运行身份/)
})

test('followup已进原生队列但turn尚未开始也不能卸掉text守卫或替换运行',()=>{
 const events=[{seq:0,type:'agent/inbox/spliced',data:{inserted:[{source:{kind:'user',rpcId:'queued-text'}}]}}] as unknown as SessionEvent[],agent={status:'idle',session:{snapshotEvents:()=>events}} as unknown as Agent
 let disposed=0;const lift=leaseRunTools(agent,'queued-text',true,()=>()=>{disposed++});lift();assert.equal(disposed,0);assert.throws(()=>leaseRunTools(agent,'another',false,()=>()=>{}),/尚未结束/)
})
