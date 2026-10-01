import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('任务运行会话可通过受认证的精确读取接口恢复，但不进入普通目录',async()=>{
  const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
  assert.match(source,/['"]conversations\/read['"]/)
  assert.match(source,/endpoint===['"]conversations\/read['"]\?await service\.bySession\(owner,sessionInput\(payload\)\)/)
})

test('ConversationService 构造带第 4 参 readRole，按岗位新建会话在宿主里已接线',async()=>{
  const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
  assert.match(source,/const service=new ConversationService\(repository,\{/)
  // 第 4 参必须紧跟在 identity 参数之后：既是可选尾参，也是 I26（四）真链路能转绿的唯一接线点。
  assert.match(source,/\},\{id:randomUUID,now:\(\)=>new Date\(\)\.toISOString\(\)\},async\(actor,roleId\)=>\{\s*const \{pool,identity,plans\}=await autoDreamPlans\(\)\s*return \(await new RoleService\(pool,identity,\{plans\}\)\.list\(actor,\{\}\)\)\.find\(role=>role\.id===roleId\)\s*\}\)/)
})
