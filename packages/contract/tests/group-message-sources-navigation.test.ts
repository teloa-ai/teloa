import test from 'node:test'
import assert from 'node:assert/strict'
import {citedGroupMessageIds} from '../src/group-message-sources.ts'

// 实际合成B2格式的匿名化回归；原样字节与回执只保留在私有验收工件。
const actualB2="最终复核记录：\n\n- **初稿**：来源消息 `10000000-0000-4000-8000-000000000001`。替换结果为将“浅灰”标签替换为“银灰”，其它标签保持不变。\n- **修订稿**：来源消息 `20000000-0000-4000-8000-000000000002`。替换结果为将“浅灰”标签替换为“雾银”，其它标签保持不变。\n- **修订关系**：修订稿沿用初稿的替换范围及“其它标签保持不变”的内容，仅将初稿中的替换结果“银灰”进一步改为“雾银”。\n\n以上仅依据本群当前提供的松岚合成消息整理。"
const actualMessages=["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"]
const actualRole="30000000-0000-4000-8000-000000000003"

test('B2来源消息格式保留两条合成消息编号',()=>{
 assert.deepEqual(citedGroupMessageIds(actualB2),actualMessages)
})

test('角色、外来普通UUID与代码文本不成为消息引用',()=>{
 const id=actualMessages[0],tick=String.fromCharCode(96),fence=tick.repeat(3),nl=String.fromCharCode(10)
 for(const body of ['作者 roleId: '+actualRole,'角色编号 '+actualRole,'外来资料 UUID: 8c1a17a9-35ed-479c-b52b-f0636162038b',fence+'text'+nl+'来源消息 '+id+nl+fence,tick+'来源消息 '+id+tick]){
  assert.deepEqual(citedGroupMessageIds(body),[])
 }
})

test('既有明确编号语法与去重保持',()=>{
 const id=actualMessages[0]
 assert.deepEqual(citedGroupMessageIds('消息编号：'+id+String.fromCharCode(10)+'来源消息 '+id),[id])
})
