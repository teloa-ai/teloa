import test from 'node:test'
import assert from 'node:assert/strict'
import {composeFromWorkspace} from '../src/client/industry-composition.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {IndustryPluginInstance} from '../src/client/industry-plugin-api.ts'
const load={id:'load',status:'active',space:{scope:'general'},items:[{instanceId:'instance',kind:'plugin',title:'Tools',status:'instantiated'}]} as unknown as IndustryLoadRecord
test('扩展显示真实安装阶段，不从实例化状态推断需重启',()=>{
 for(const [state,expected] of [['needs_install','pending-install'],['installing','installing'],['pending-enable','pending-enable'],['restart-required','needs-restart'],['failed','install-failed'],['active','installed']] as const){
  const sections=composeFromWorkspace({scope:'general',loads:[load],roles:[],plugins:[{loadId:'load',itemInstanceId:'instance',state} as IndustryPluginInstance]})
  assert.equal(sections[0]!.items[0]!.state,expected,state)
 }
 assert.equal(composeFromWorkspace({scope:'general',loads:[load],roles:[]})[0]!.items[0]!.state,'unverified')
})
test('业务扩展的管理目标保留实例身份，不跳市场发现页',()=>{
 assert.deepEqual(composeFromWorkspace({scope:'general',loads:[load],roles:[]})[0]!.items[0]!.go,{kind:'extension',instanceId:'instance'})
})
