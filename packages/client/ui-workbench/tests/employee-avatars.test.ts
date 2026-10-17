import './employee-asset-test-loader.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {ROLE_AVATAR_KEYS} from '../../../contract/src/roles.ts'
const {employeeAvatars,employeeAvatar,employeeAvatarName}=await import('../lib/types/client/employee-avatars.js')
test('28款内置小松鼠与角色白名单一一对应，旧身份回退固定通用形象',()=>{
 assert.equal(employeeAvatars.length,28)
 assert.deepEqual(employeeAvatars.map(item=>item.key),[...ROLE_AVATAR_KEYS])
 assert.equal(new Set(employeeAvatars.map(item=>item.src)).size,28)
 assert.equal(employeeAvatar().key,'general')
 for(const locale of ['zh-CN','zh-Hant','zh-HK','en'])for(const key of ROLE_AVATAR_KEYS)assert.ok(employeeAvatarName(key,locale))
 assert.equal(employeeAvatarName('project','zh-HK'),'項目協調員')
 assert.equal(employeeAvatarName('project','zh-Hant'),'專案協調員')
})
