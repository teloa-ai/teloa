import test from 'node:test'
import assert from 'node:assert/strict'
import {encodeDialogueDrag,resolveDialogueDrop} from '../src/client/dialogue-directory-drag.ts'

test('目录拖动只接受本次原ID且仍在当前可见范围的会话或群',()=>{
 const session={kind:'session' as const,id:'original'},group={kind:'group' as const,id:'original'},rows=[session,group]
 assert.equal(resolveDialogueDrop(encodeDialogueDrag(session),session,rows),session)
 assert.equal(resolveDialogueDrop(encodeDialogueDrag(group),group,rows),group)
 assert.equal(resolveDialogueDrop(encodeDialogueDrag(group),session,rows),undefined,'同名同ID的群不能冒充会话')
 assert.equal(resolveDialogueDrop(encodeDialogueDrag(session),undefined,rows),undefined,'外部拖入没有本次活动拖动')
 assert.equal(resolveDialogueDrop(encodeDialogueDrag(session),session,[group]),undefined,'过滤或归档后不可拖入已移出范围的会话')
 assert.equal(resolveDialogueDrop('{"kind":"session","id":"original","scope":"other"}',session,rows),undefined)
 assert.equal(resolveDialogueDrop('not json',session,rows),undefined)
 assert.equal(resolveDialogueDrop('null',session,rows),undefined)
 assert.deepEqual(rows,[{kind:'session',id:'original'},{kind:'group',id:'original'}])
})
