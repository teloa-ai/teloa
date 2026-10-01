import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {imRequestId} from '../src/core/request-id.ts'

const shape=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

test('1. 同 (channelId,chatId,messageId,step) 恒同输出；不同 step 不等；形态为 v5（版本 nibble 5、变体 8–b）',()=>{
 const a=imRequestId('telegram','100','42','prompt')
 assert.equal(a,imRequestId('telegram','100','42','prompt'))
 assert.notEqual(a,imRequestId('telegram','100','42','conv'))
 assert.notEqual(a,imRequestId('telegram','100','42'))
 assert.match(a,shape)
 assert.equal(a[14],'5')
})

test('1a. 裁定①：chatId 参与派生（Telegram message_id、Slack ts 只在聊天内唯一）',()=>{
 assert.notEqual(imRequestId('telegram','100','42','prompt'),imRequestId('telegram','200','42','prompt'))
 assert.notEqual(imRequestId('slack','C1','1700000000.000100'),imRequestId('slack','C2','1700000000.000100'))
})

test('1b. 派生口径：sha256(channelId:chatId:messageId[:step]) 前 16 字节整形',()=>{
 const bytes=createHash('sha256').update('feishu:oc_1:om_9:group').digest().subarray(0,16)
 bytes[6]=(bytes[6]!&0x0f)|0x50
 bytes[8]=(bytes[8]!&0x3f)|0x80
 const hex=bytes.toString('hex')
 assert.equal(imRequestId('feishu','oc_1','om_9','group'),`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`)
})

test('1c. 100 个随机输入无碰撞且全部匹配正则',()=>{
 const seen=new Set<string>()
 for(let i=0;i<100;i+=1){
  const id=imRequestId('slack',`C${Math.random().toString(36).slice(2)}`,`${Date.now()}.${i}`,i%2?'prompt':undefined)
  assert.match(id,shape)
  seen.add(id)
 }
 assert.equal(seen.size,100)
})
