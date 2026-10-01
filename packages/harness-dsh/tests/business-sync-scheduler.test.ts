import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {WorkError} from '@teloa/contract'
import {createBusinessSyncTick,type BusinessSyncTickPorts} from '../src/business-sync-scheduler.ts'
import {startPlanScheduler} from '../src/plan-scheduler.ts'

const owner='local:teloa-owner',now='2026-09-26T00:00:00.000Z'
const settle=()=>new Promise(resolve=>setImmediate(resolve))

function fixture(options:{failFirstSync?:boolean;scopes?:string[];failRefresh?:()=>boolean}={}){
 const calls:string[]=[],warnings:unknown[][]=[],refreshes:unknown[][]=[]
 const sync={
  due:async(ownerId:string,at:string)=>{calls.push('sync.due:'+ownerId+':'+at);return [{scope:'SOC',mappingId:'alerts'},{scope:'SOC',mappingId:'assets'}]},
  run:async(actor:{ownerId:string;scopeIds:string[]},input:{scope:string;mappingId:string;trigger:string})=>{
   calls.push('sync.run:'+input.mappingId+':'+input.trigger+':'+actor.ownerId)
   if(options.failFirstSync&&input.mappingId==='alerts')throw new WorkError('teloa/source-unavailable','select secret from x where token=abc')
   return {}
  },
 }
 const dashboards={
  due:async()=>{calls.push('dashboards.due');return [{scope:'SOC',dashboardId:'overview',widgetIds:['open']}]},
  refresh:async(...args:unknown[])=>{calls.push('dashboards.refresh');refreshes.push(args);if(options.failRefresh?.())throw new WorkError('teloa/source-unavailable','看板引用的组件不在本业务范围内');return {}},
 }
 const ports:BusinessSyncTickPorts={owner,services:async()=>({sync,dashboards}) as never,scopeIds:async()=>options.scopes??['SOC'],logger:{warn:(...args:unknown[])=>{warnings.push(args)}}}
 return {calls,warnings,refreshes,tick:createBusinessSyncTick(ports)}
}

test('一次 tick：同步到期 2 项各跑一次、看板到期 1 项刷新一次（定时触发、组件级刷新透传）',async()=>{
 const f=fixture()
 await f.tick(now,new AbortController().signal)
 assert.deepEqual(f.calls,['sync.due:'+owner+':'+now,'sync.run:alerts:schedule:'+owner,'sync.run:assets:schedule:'+owner,'dashboards.due','dashboards.refresh'])
 const [actor,input,,options]=f.refreshes[0] as [{ownerId:string},{requestId:string;scope:string;dashboardId:string},AbortSignal,unknown]
 assert.equal(actor.ownerId,owner)
 assert.match(input.requestId,/^[a-f0-9-]{36}$/)
 assert.deepEqual({...input,requestId:undefined},{requestId:undefined,scope:'SOC',dashboardId:'overview'})
 assert.deepEqual(options,{trigger:'schedule',widgetIds:['open']})
 assert.equal(f.warnings.length,0)
})

test('一项失败只告警一行（码与标识，不含原错误文本），其余照常执行',async()=>{
 const f=fixture({failFirstSync:true})
 await f.tick(now,new AbortController().signal)
 assert.deepEqual(f.calls.filter(call=>call.startsWith('sync.run')||call==='dashboards.refresh'),['sync.run:alerts:schedule:'+owner,'sync.run:assets:schedule:'+owner,'dashboards.refresh'])
 assert.equal(f.warnings.length,1)
 assert.ok(f.warnings[0]!.includes('teloa/source-unavailable'))
 assert.equal(JSON.stringify(f.warnings).includes('secret'),false)
})

test('取消信号：第一项之后不再调用；范围已注销的到期项跳过',async()=>{
 const f=fixture(),controller=new AbortController()
 const originalCalls=f.calls
 const tick=createBusinessSyncTick({owner,services:async()=>({
  sync:{due:async()=>[{scope:'SOC',mappingId:'alerts'},{scope:'SOC',mappingId:'assets'}],run:async(_actor:unknown,input:{mappingId:string})=>{originalCalls.push('run:'+input.mappingId);controller.abort()}},
  dashboards:{due:async()=>{originalCalls.push('dashboards.due');return []},refresh:async()=>{}},
 }) as never,scopeIds:async()=>['SOC'],logger:{warn:()=>{}}})
 await assert.rejects(tick(now,controller.signal))
 assert.deepEqual(originalCalls,['run:alerts'])
 const gone=fixture({scopes:['AppSec']})
 await gone.tick(now,new AbortController().signal)
 assert.deepEqual(gone.calls.filter(call=>call.startsWith('sync.run')||call==='dashboards.refresh'),[])
})

test('挂在 startPlanScheduler 上：长耗时 tick 期间连推 3 次计时器只调 1 次；stop 之后再推 0 次',async()=>{
 let ticks=0,work=()=>{}
 const gate=()=>{let release=()=>{};const promise=new Promise<void>(resolve=>{release=resolve});return {promise,release}}
 let current=gate()
 const tick=async(_now:string,_signal:AbortSignal)=>{ticks++;await current.promise}
 const stop=startPlanScheduler({recover:async()=>{},tick,report:()=>{}},()=>now,callback=>{work=callback;return ()=>{work=()=>{}}},{observe:()=>()=>{}})
 await settle();current.release();await settle();await settle()
 assert.equal(ticks,1,'启动即跑一次')
 current=gate()
 work();await settle()
 assert.equal(ticks,2)
 for(let index=0;index<3;index++){work();await settle()}
 assert.equal(ticks,2,'单飞：进行中的 tick 期间连推 3 次不重入')
 const pending=work
 current.release();await settle();await settle()
 await stop()
 for(let index=0;index<3;index++){pending();work();await settle()}
 assert.equal(ticks,2,'stop 之后再推 0 次')
})

test('宿主接线：tick 经 runtimeAdmission 交给 startPlanScheduler 并登记关闭；本文件不自建计时器',()=>{
 const scheduler=readFileSync(new URL('../src/business-sync-scheduler.ts',import.meta.url),'utf8')
 assert.doesNotMatch(scheduler,/setTimeout|setInterval/)
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/const businessSyncTick=createBusinessSyncTick\(\{owner,/)
 assert.match(source,/resources\.beforeDatabaseClose\(startPlanScheduler\(\{recover:async\(\)=>\{\},tick:\(now,signal\)=>runtimeAdmission\.run\(\(\)=>businessSyncTick\(now,signal\)\),report:\(_phase,code\)=>ctx\.logger\.warn\('Teloa 业务同步待恢复：%s',code\)\}/)
})

test('看板刷新连续失败按倍数退避（1、2、4 分钟…封顶 1 小时）；成功一次即清零',async()=>{
 let failing=true
 const f=fixture({failRefresh:()=>failing})
 const at=(seconds:number)=>new Date(Date.parse(now)+seconds*1000).toISOString()
 const refreshed=async(seconds:number)=>{const before=f.calls.filter(call=>call==='dashboards.refresh').length;await f.tick(at(seconds),new AbortController().signal);return f.calls.filter(call=>call==='dashboards.refresh').length>before}
 assert.equal(await refreshed(0),true)
 assert.equal(await refreshed(30),false,'第 1 次失败后退避 60 秒')
 assert.equal(await refreshed(60),true)
 assert.equal(await refreshed(150),false,'第 2 次失败后退避 120 秒')
 assert.equal(await refreshed(180),true)
 assert.equal(await refreshed(400),false,'第 3 次失败后退避 240 秒')
 failing=false
 assert.equal(await refreshed(420),true)
 assert.equal(await refreshed(421),true,'成功后清零，下一次到期照常刷新')
 assert.equal(f.warnings.length,3)
})
