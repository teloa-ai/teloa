import test from 'node:test'
import assert from 'node:assert/strict'
import {savedArtifactMessage} from '../src/artifact-messages.ts'
const message={sessionId:'s1',messageId:'m1',seq:3,role:'user',at:'2026-09-11T00:00:00Z',text:' 正文\r\n',interrupted:false,omittedBlocks:0,images:[{blockIndex:1,attachment:{attachmentId:'sha256:abc',mediaType:'image/png',bytes:3,width:1,height:1,name:'图.png'}}]}
test('原消息快照保持正文与图片身份，规范对象键序',()=>{
 assert.deepEqual(savedArtifactMessage(message),message)
 assert.equal(JSON.stringify(savedArtifactMessage(Object.fromEntries(Object.entries(message).reverse()))),JSON.stringify(savedArtifactMessage(message)))
})
test('拒绝浏览器地址、额外字段、重复图片位置和不合法消息元数据',()=>{
 for(const value of [{...message,ownerId:'other'},{...message,seq:-1},{...message,interrupted:'false'},{...message,omittedBlocks:-1},{...message,images:[...message.images,...message.images]},...['blob:temp','https://example.com/a.png','data:image/png;base64,a'].map(attachmentId=>({...message,images:[{blockIndex:1,attachment:{...message.images[0]!.attachment,attachmentId}}]}))])assert.throws(()=>savedArtifactMessage(value))
})
