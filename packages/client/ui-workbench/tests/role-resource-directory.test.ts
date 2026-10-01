import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleResourceDirectory} from '../src/client/role-resource-directory.ts'
import {roleScopeOptions} from '../src/client/role-scope-options.ts'

const old={id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',title:'旧标题',sourceId:'source',sourceVersion:'a'.repeat(64),scopeIds:['general'],version:1,status:'active' as const,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}
const industry={...old,title:'通用研究方法',scopeIds:['space-22222222-2222-4222-8222-222222222222'],version:2}
test('岗位资料目录合并通用摘要与行业实例资源并按身份版本去重',async()=>{const directory=await createRoleResourceDirectory({directory:async()=>({drafts:[],resources:[old]})},{list:async()=>[{resource:industry}]});assert.deepEqual(directory.resources,[industry])})
test('任一来源读取失败原样失败，使RoleKnowledge保留旧目录并显示错误',async()=>{await assert.rejects(createRoleResourceDirectory({directory:async()=>({drafts:[],resources:[old]})},{list:async()=>{throw Error('行业资料断开')}}),/行业资料断开/)})
test('岗位已有动态scope即使目录名称暂未加载也保留为可见选项',()=>{assert.deepEqual(roleScopeOptions({general:'通用'},['space-22222222-2222-4222-8222-222222222222']),[['general','通用'],['space-22222222-2222-4222-8222-222222222222','space-22222222-2222-4222-8222-222222222222']])})
