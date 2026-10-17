import assert from 'node:assert/strict'
import test from 'node:test'
import {roleDefinition} from '../src/roles.ts'
const fields={name:'Researcher',kind:'employee',scopes:['general'],duty:'Review sources',dataScope:'Selected materials',executionScope:'Draft only',skills:[],knowledge:[]}
test('员工头像选择在定义读写中保持同一标识，旧记录兼容且不允许任意图片',()=>{
 assert.equal(roleDefinition({...fields,avatarKey:'researcher'}).avatarKey,'researcher')
 assert.equal(roleDefinition(fields).avatarKey,undefined)
 assert.throws(()=>roleDefinition({...fields,avatarKey:'https://example.test/private.png'}))
})
