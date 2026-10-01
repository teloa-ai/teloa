import test from 'node:test'
import assert from 'node:assert/strict'
import {bundledAddDecision,bundledAddInput,bundledAddReason,executeBundledAdd} from '../src/market-session-tools.ts'

const view=(state:string)=>({id:'im-gateway',packageName:'@teloa/im-gateway',version:'0.2.0-alpha.6',state,configuredChannels:0})
test('只认 bundled-extension 候选；其它候选返回 undefined 交给原路径',()=>{
 assert.equal(bundledAddInput({candidate:{kind:'bundled-extension',extensionId:'im-gateway'}}),'im-gateway')
 assert.equal(bundledAddInput({candidate:{kind:'catalog',entryId:'x'},expectedFingerprint:'a'.repeat(64)}),undefined)
 assert.throws(()=>bundledAddInput({candidate:{kind:'bundled-extension',extensionId:'evil'}}),{code:'teloa/invalid-input'})
 // 本地中文检索虽已登记为随附扩展，会话内启用卡的文案与去向只针对 IM 通道：会话内仍只收 im-gateway
 assert.throws(()=>bundledAddInput({candidate:{kind:'bundled-extension',extensionId:'local-embedding'}}),{code:'teloa/invalid-input'})
 assert.throws(()=>bundledAddInput({candidate:{kind:'bundled-extension',extensionId:'im-gateway',packageName:'@x/y'}}),{code:'teloa/invalid-input'})
})
test('确认卡写明随附、不下载、即时生效不需重启、凭据不经聊天',()=>{
 const reason=bundledAddReason(view('available') as never,'')
 for(const text of ['IM 通道','@teloa/im-gateway 0.2.0-alpha.6','不从网络下载','立即启用并加载，不需要重启','不经聊天'])assert.ok(reason.includes(text),text)
})
test('预检一律出确认卡，不论当前状态（消除检查—执行时间窗）',()=>{
 for(const state of ['available','enable-pending','active','failed','disable-pending'])
  assert.equal(bundledAddDecision(view(state) as never,{kind:'allow'} as never).kind,'ask',state)
 assert.match(bundledAddDecision(view('active') as never,{kind:'ask',reason:'原生'} as never).reason,/原生规则同时要求确认：原生/)
})
test('执行：未启用才写入；即时生效回「已启用」并引导到设置页；已启用不重复写',async()=>{
 const calls:string[]=[]
 const ports={bundledExtensions:async(endpoint:string)=>{calls.push(endpoint);return endpoint==='bundled-extensions/list'?[view('available')]:view('active')}}
 const result=await executeBundledAdd(ports as never,'im-gateway')
 assert.deepEqual(calls,['bundled-extensions/list','bundled-extensions/set'])
 assert.equal(result.state,'active')
 assert.match(result.guidance,/IM 通道已启用，现在就可以到 设置 · IM 通道 配置渠道/)
 assert.doesNotMatch(result.guidance,/重启/)
 assert.deepEqual(result.next,{page:'settings/teloa-im-channels'})
 // 即时启用没能套用（回退为重启生效）时如实说明
 const pending={bundledExtensions:async(endpoint:string)=>endpoint==='bundled-extensions/list'?[view('available')]:view('enable-pending')}
 assert.match((await executeBundledAdd(pending as never,'im-gateway')).guidance,/重启 Teloa 后生效/)
 calls.length=0
 const active={bundledExtensions:async(endpoint:string)=>{calls.push(endpoint);return [view('active')]}}
 assert.equal((await executeBundledAdd(active as never,'im-gateway')).state,'active')
 assert.deepEqual(calls,['bundled-extensions/list'])
})
test('宿主回包形状不对归为 invalid-host-response（list 与 set 都是）',async()=>{
 const badList={bundledExtensions:async()=>[{...view('available'),version:'undefined'}]}
 await assert.rejects(executeBundledAdd(badList as never,'im-gateway'),{code:'teloa/invalid-host-response'})
 const badSet={bundledExtensions:async(endpoint:string)=>endpoint==='bundled-extensions/list'?[view('available')]:{state:'enable-pending'}}
 await assert.rejects(executeBundledAdd(badSet as never,'im-gateway'),{code:'teloa/invalid-host-response'})
})
test('确认卡不随预检状态变：写明未启用才写入、已启用不做改动（执行时状态可能已变）',()=>{
 for(const state of ['available','active','enable-pending','failed','disable-pending']){
  const reason=bundledAddReason(view(state) as never,'')
  assert.equal(reason,bundledAddReason(view('available') as never,''),state)
  assert.match(reason,/未启用时立即启用并加载，不需要重启 Teloa；已启用则不做改动/)
 }
})
