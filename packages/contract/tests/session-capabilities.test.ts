import test from 'node:test'
import assert from 'node:assert/strict'
import * as contract from '../src/index.ts'

test('会话分类读契约区分真实能力与unknown，拒绝伪造主体、未知/重复/空能力',()=>{
 const read=Reflect.get(contract,'isSessionCapabilitySnapshot') as typeof import('../src/index.ts').isSessionCapabilitySnapshot
 assert.equal(typeof read,'function')
 const known={schema:'teloa.session-capabilities/v1',sessionId:'native-session',status:'ready',requiredCapabilities:['people','automation']}
 assert.equal(read(known),true)
 const copy=contract.readSessionCapabilitySnapshot(known)
 assert.deepEqual(copy,known);assert.notEqual(copy,known);assert.equal(Object.isFrozen(copy),true);assert.equal(Object.isFrozen(copy.requiredCapabilities),true)
 assert.equal(read({...known,status:'unavailable',requiredCapabilities:null}),true)
 for(const change of [{status:'unavailable'},{requiredCapabilities:[]},{requiredCapabilities:null},{requiredCapabilities:['invented']},{requiredCapabilities:['people','people']},{ownerId:'forged'},{sessionId:'../foreign'},{schema:'wrong'},{status:'unknown'}])assert.equal(read({...known,...change}),false)
 assert.throws(()=>contract.readSessionCapabilitySnapshot({...known,requiredCapabilities:[]}),{code:'teloa/invalid-host-response'})
})
