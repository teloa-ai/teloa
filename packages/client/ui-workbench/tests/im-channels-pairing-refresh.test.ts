import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {pollBindingsUntil,pairingRefreshMs}=await import('../lib/types/client/ImChannelsSettingsPage.js')

const source=readFileSync(new URL('../src/client/ImChannelsSettingsPage.tsx',import.meta.url),'utf8')

test('配对码有效期内定期刷新绑定列表：IM 侧配对成功后无需手动刷新即出现',t=>{
 t.mock.timers.enable({apis:['setInterval','Date'],now:0})
 let calls=0
 const stop=pollBindingsUntil(10*pairingRefreshMs,async()=>{calls+=1})
 t.mock.timers.tick(pairingRefreshMs-1)
 assert.equal(calls,0)
 t.mock.timers.tick(1)
 assert.equal(calls,1)
 t.mock.timers.tick(pairingRefreshMs*2)
 assert.equal(calls,3)
 stop()
})

test('配对码到期后停止刷新；刷新失败不抛出',t=>{
 t.mock.timers.enable({apis:['setInterval','Date'],now:0})
 let calls=0
 pollBindingsUntil(2*pairingRefreshMs,async()=>{calls+=1;throw Error('网络断开')})
 // 逐轮推进：一次 tick 大跨度时模拟时钟先跳到终点再触发回调。
 for(let round=0;round<10;round+=1)t.mock.timers.tick(pairingRefreshMs)
 assert.equal(calls,1,'到期那一刻起不再刷新')
})

test('离开页面（停止函数被调用）即停',t=>{
 t.mock.timers.enable({apis:['setInterval','Date'],now:0})
 let calls=0
 const stop=pollBindingsUntil(100*pairingRefreshMs,async()=>{calls+=1})
 t.mock.timers.tick(pairingRefreshMs)
 stop()
 t.mock.timers.tick(pairingRefreshMs*10)
 assert.equal(calls,1)
})

test('页面接线：生成配对码后按码的有效期轮询，「复制并隐藏」不停止；卸载时清理',()=>{
 assert.match(source,/useEffect\(\(\)=>pairingUntil===undefined\?undefined:pollBindingsUntil\(pairingUntil,/)
 assert.match(source,/setPairingUntil\(Date\.parse\(code\.expiresAt\)\)/)
 assert.doesNotMatch(source,/onCopy=\{\(\)=>\{[^}]*setPairingUntil/)
})
