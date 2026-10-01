import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntimeSettingsSurface} from '../src/client/runtime-settings-surface.ts'
test('运行设置使用拥有者提供的正文，旧拥有者卸载不会清掉新一代正文',()=>{
 const surface=createRuntimeSettingsSurface();let notifications=0
 const off=surface.subscribe(()=>{notifications++})
 assert.equal(surface.getSnapshot(),undefined)
 const old=surface.attach(()=>'old'),dispose=surface.attach(()=>'official page')
 old();assert.equal(surface.getSnapshot()!(),'official page')
 dispose();assert.equal(surface.getSnapshot(),undefined)
 assert.equal(notifications,3);off()
})
