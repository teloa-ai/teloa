import test from 'node:test'
import assert from 'node:assert/strict'
import {bundledExtensions,bundledExtensionEndpoints,isReservedOfficialPackage,readBundledExtensionSetInput,readBundledExtensionView} from '../src/bundled-extensions.ts'

test('随附扩展只有编译期常量里的 IM 通道与本地中文检索',()=>{
 assert.deepEqual(bundledExtensions,[{id:'im-gateway',packageName:'@teloa/im-gateway'},{id:'local-embedding',packageName:'@teloa/local-embedding'}])
 assert.deepEqual(bundledExtensionEndpoints,['bundled-extensions/list','bundled-extensions/set'])
})
test('@teloa/ 作用域保留给官方',()=>{
 assert.equal(isReservedOfficialPackage('@teloa/im-gateway'),true)
 assert.equal(isReservedOfficialPackage('@Teloa/im-gateway'),true)
 assert.equal(isReservedOfficialPackage('@TELOA/x'),true)
 assert.equal(isReservedOfficialPackage('@teloa-ai/x'),false)
 assert.equal(isReservedOfficialPackage('teloa'),false)
})
test('set 入参精确键、只认已知 id 与布尔',()=>{
 assert.deepEqual(readBundledExtensionSetInput({extensionId:'im-gateway',enabled:true}),{extensionId:'im-gateway',enabled:true})
 assert.deepEqual(readBundledExtensionSetInput({extensionId:'local-embedding',enabled:false}),{extensionId:'local-embedding',enabled:false})
 for(const bad of [{extensionId:'other',enabled:true},{extensionId:'im-gateway',enabled:'yes'},{extensionId:'im-gateway',enabled:true,extra:1},null])
  assert.throws(()=>readBundledExtensionSetInput(bad),{code:'teloa/invalid-input'})
})
test('视图读取核对包名与状态',()=>{
 const view={id:'im-gateway',packageName:'@teloa/im-gateway',version:'0.2.0-alpha.6',state:'enable-pending',configuredChannels:2}
 assert.deepEqual(readBundledExtensionView(view),view)
 assert.throws(()=>readBundledExtensionView({...view,packageName:'@evil/im-gateway'}),{code:'teloa/invalid-input'})
 assert.throws(()=>readBundledExtensionView({...view,state:'installed'}),{code:'teloa/invalid-input'})
 assert.throws(()=>readBundledExtensionView({...view,configuredChannels:-1}),{code:'teloa/invalid-input'})
 // 包名必须与 id 对应的随附包一致，不能互换
 const embedding={id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.0-alpha.6',state:'available',configuredChannels:0}
 assert.deepEqual(readBundledExtensionView(embedding),embedding)
 assert.throws(()=>readBundledExtensionView({...embedding,packageName:'@teloa/im-gateway'}),{code:'teloa/invalid-input'})
 // memoryRisk 只属于本地中文检索，且必须是布尔
 assert.deepEqual(readBundledExtensionView({...embedding,memoryRisk:true}),{...embedding,memoryRisk:true})
 assert.throws(()=>readBundledExtensionView({...embedding,memoryRisk:'yes'}),{code:'teloa/invalid-input'})
 assert.throws(()=>readBundledExtensionView({...view,memoryRisk:false}),{code:'teloa/invalid-input'})
})
