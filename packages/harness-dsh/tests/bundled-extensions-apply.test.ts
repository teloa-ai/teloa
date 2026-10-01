import test from 'node:test'
import assert from 'node:assert/strict'
import {BundledHotApplyError,BundledHotApplyUnsupported,bundledHotApplyWorkError,hotApplyBundledExtension,onlyExtensionRowDiffers,type BundledHotApplyPorts,type PatchGeneration} from '../src/bundled-extensions-apply.ts'

const IM={packageName:'@teloa/im-gateway',rowId:'teloa-im-gateway'}
const base=[{id:'teloa-harness-dsh',name:'@teloa/harness-dsh'},{id:'hmr',name:'@deepseek-ai/dsh-hmr',disabled:true},{id:'approval',name:'@deepseek-ai/dsh-approval',config:{policy:'ask'}}]
const generation=(rows:unknown[]):PatchGeneration=>[{insert:rows}]
const withIm=generation([...base.slice(0,1),{id:'teloa-im-gateway',name:'@teloa/im-gateway'},...base.slice(1)])
const withoutIm=generation(base)

test('只差本扩展那一行才算可热套用：启用多一行、停用少一行',()=>{
 assert.equal(onlyExtensionRowDiffers(withoutIm,withIm,{...IM,enabled:true}),true)
 assert.equal(onlyExtensionRowDiffers(withIm,withoutIm,{...IM,enabled:false}),true)
 // 键序不同不算差别
 assert.equal(onlyExtensionRowDiffers(withoutIm,generation([{name:'@teloa/harness-dsh',id:'teloa-harness-dsh'},{name:'@teloa/im-gateway',id:'teloa-im-gateway'},...base.slice(1)]),{...IM,enabled:true}),true)
})
test('其它行有任何变化（改配置、加第三方行、换顺序）都不热套用',()=>{
 const changedPin=generation([...base.slice(0,2),{id:'approval',name:'@deepseek-ai/dsh-approval',config:{policy:'never'}},{id:'teloa-im-gateway',name:'@teloa/im-gateway'}])
 assert.equal(onlyExtensionRowDiffers(withoutIm,changedPin,{...IM,enabled:true}),false)
 const extraRow=generation([...base,{id:'teloa-im-gateway',name:'@teloa/im-gateway'},{id:'vendor',name:'@vendor/plugin'}])
 assert.equal(onlyExtensionRowDiffers(withoutIm,extraRow,{...IM,enabled:true}),false)
 const reordered=generation([base[1],base[0],base[2],{id:'teloa-im-gateway',name:'@teloa/im-gateway'}])
 assert.equal(onlyExtensionRowDiffers(withoutIm,reordered,{...IM,enabled:true}),false)
})
test('目标行必须恰好是 bundle 自带的 {id,name}：带配置、注入、换 id 或出现两行都不热套用；停用后不得残留',()=>{
 for(const row of [{id:'teloa-im-gateway',name:'@teloa/im-gateway',config:{x:1}},{id:'teloa-im-gateway',name:'@teloa/im-gateway',inject:['llm']},{id:'other-id',name:'@teloa/im-gateway'}])
  assert.equal(onlyExtensionRowDiffers(withoutIm,generation([...base,row]),{...IM,enabled:true}),false,JSON.stringify(row))
 assert.equal(onlyExtensionRowDiffers(withoutIm,generation([...base,{id:'teloa-im-gateway',name:'@teloa/im-gateway'},{id:'dup',name:'@teloa/im-gateway'}]),{...IM,enabled:true}),false)
 assert.equal(onlyExtensionRowDiffers(withIm,withIm,{...IM,enabled:false}),false)
 // 形态不是单个 insert 列表时不热套用
 assert.equal(onlyExtensionRowDiffers([{insert:base},{id:'x'}],withIm,{...IM,enabled:true}),false)
})

type Calls={reconcile:{patches:PatchGeneration;required:readonly string[]}[];verify:number;window:{enabled:boolean}[];warn:string[]}
function ports(options:{current?:PatchGeneration|null;next?:PatchGeneration;verify?:(n:number)=>void;reconcile?:(n:number)=>void;loaded?:()=>boolean;applied?:(patches:PatchGeneration)=>PatchGeneration}={}){
 const calls:Calls={reconcile:[],verify:0,window:[],warn:[]}
 // 当前生效代随 reconcile 成功而更新（与真实根 Include 一致）；applied 可模拟套用后生效代与期望不符。
 let active=options.current??withoutIm
 const value:BundledHotApplyPorts={
  current:()=>options.current===null?undefined:{patches:active,parentURL:'file:///profile/'},
  read:()=>['raw'],
  prepare:()=>options.next??withIm,
  reconcile:async(patches,required)=>{calls.reconcile.push({patches,required});options.reconcile?.(calls.reconcile.length);active=options.applied?options.applied(patches):patches},
  verify:async()=>{calls.verify+=1;options.verify?.(calls.verify)},
  loaded:options.loaded??(()=>calls.reconcile.length%2===1),
  window:async(_name,enabled,operation)=>{calls.window.push({enabled});return operation()},
  warn:message=>{calls.warn.push(message)},
 }
 return {calls,ports:value}
}

test('启用：预检 → 只在窗口内套用新一代（要求本扩展行激活）→ 事后复验 → applied',async()=>{
 const {calls,ports:p}=ports()
 assert.equal(await hotApplyBundledExtension(p,{...IM,enabled:true}),'applied')
 assert.deepEqual(calls.reconcile,[{patches:withIm,required:['teloa-im-gateway']}])
 assert.equal(calls.verify,2)
 assert.deepEqual(calls.window,[{enabled:true}])
})
test('停用：套用去掉本扩展行的一代、不要求激活，确认已卸下',async()=>{
 const {calls,ports:p}=ports({current:withIm,next:withoutIm,loaded:()=>false})
 assert.equal(await hotApplyBundledExtension(p,{...IM,enabled:false}),'applied')
 assert.deepEqual(calls.reconcile,[{patches:withoutIm,required:[]}])
})
test('不支持热套用或还有其它变化：不动运行中组合，返回 restart-required（保留重启生效作回退）',async()=>{
 const unsupported=ports({current:null})
 assert.equal(await hotApplyBundledExtension(unsupported.ports,{...IM,enabled:true}),'restart-required')
 assert.deepEqual(unsupported.calls.reconcile,[])
 const other=ports({next:generation([...base,{id:'teloa-im-gateway',name:'@teloa/im-gateway'},{id:'vendor',name:'@vendor/x'}])})
 assert.equal(await hotApplyBundledExtension(other.ports,{...IM,enabled:true}),'restart-required')
 assert.deepEqual(other.calls.reconcile,[])
})
test('预检不过：一行都不套用，报 refused（运行中组合未动）',async()=>{
 const {calls,ports:p}=ports({verify:()=>{throw Error('pin')}})
 await assert.rejects(hotApplyBundledExtension(p,{...IM,enabled:true}),(error:unknown)=>error instanceof BundledHotApplyError&&error.kind==='refused'&&error.rolledBack)
 assert.deepEqual(calls.reconcile,[])
})
test('套用失败（扩展激活失败）：回滚到调用前那一代，报 failed',async()=>{
 const {calls,ports:p}=ports({reconcile:n=>{if(n===1)throw Error('activation failed')}})
 await assert.rejects(hotApplyBundledExtension(p,{...IM,enabled:true}),(error:unknown)=>error instanceof BundledHotApplyError&&error.kind==='failed'&&error.rolledBack)
 assert.deepEqual(calls.reconcile.map(call=>call.patches),[withIm,withoutIm])
 assert.deepEqual(calls.reconcile[1]!.required,[])
})
test('事后复验不过：回滚到调用前那一代并再复验，报 refused',async()=>{
 const {calls,ports:p}=ports({verify:n=>{if(n===2)throw Error('hmr service appeared')}})
 await assert.rejects(hotApplyBundledExtension(p,{...IM,enabled:true}),(error:unknown)=>error instanceof BundledHotApplyError&&error.kind==='refused'&&error.rolledBack)
 assert.deepEqual(calls.reconcile.map(call=>call.patches),[withIm,withoutIm])
 assert.equal(calls.verify,3)
})
test('套用后目标没加载上：回滚，报 failed',async()=>{
 const {calls,ports:p}=ports({loaded:()=>false})
 await assert.rejects(hotApplyBundledExtension(p,{...IM,enabled:true}),(error:unknown)=>error instanceof BundledHotApplyError&&error.kind==='failed')
 assert.equal(calls.reconcile.length,2)
})
test('回滚本身失败：rolledBack=false，RPC 错误提示重启后以设置为准',async()=>{
 const {calls,ports:p}=ports({reconcile:()=>{throw Error('boom')}})
 const error=await hotApplyBundledExtension(p,{...IM,enabled:true}).catch(error=>error) as BundledHotApplyError
 assert.equal(error.rolledBack,false)
 assert.equal(calls.warn.length,1)
 const work=bundledHotApplyWorkError(error)
 assert.equal(work.code,'teloa/dependency-unavailable')
 assert.match(work.message,/重启 Teloa 后以设置为准/)
 assert.equal(bundledHotApplyWorkError(new BundledHotApplyError('x','refused',true)).code,'teloa/forbidden')
})

test('L1：停用失败回滚时以「启用」开挂接窗口，IM 能重新挂上',async()=>{
 const {calls,ports:p}=ports({current:withIm,next:withoutIm,reconcile:n=>{if(n===1)throw Error('unload failed')}})
 await assert.rejects(hotApplyBundledExtension(p,{...IM,enabled:false}),(error:unknown)=>error instanceof BundledHotApplyError&&error.kind==='failed'&&error.rolledBack)
 assert.deepEqual(calls.reconcile.map(call=>call.patches),[withoutIm,withIm])
 assert.deepEqual(calls.window,[{enabled:false},{enabled:true}],'回滚到含 IM 行的前一代时窗口按启用打开')
})
test('L2：reconcile 报找不到根 Include（尚未改动任何东西）→ 直接退回重启生效，不回滚',async()=>{
 const {calls,ports:p}=ports({reconcile:()=>{throw new BundledHotApplyUnsupported('dsh: profile reload requires the root Include entry')}})
 assert.equal(await hotApplyBundledExtension(p,{...IM,enabled:true}),'restart-required')
 assert.equal(calls.reconcile.length,1)
 assert.deepEqual(calls.warn,[])
})
test('L3：套用后生效代与比对过的那一代不一致 → 回滚，报 refused',async()=>{
 const drifted=generation([...base,{id:'teloa-im-gateway',name:'@teloa/im-gateway'},{id:'vendor',name:'@vendor/x'}])
 const {calls,ports:p}=ports({applied:patches=>patches===withIm?drifted:patches})
 await assert.rejects(hotApplyBundledExtension(p,{...IM,enabled:true}),(error:unknown)=>error instanceof BundledHotApplyError&&error.kind==='refused'&&error.rolledBack)
 assert.deepEqual(calls.reconcile.map(call=>call.patches),[withIm,withoutIm])
})
