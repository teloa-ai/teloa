import test from 'node:test'
import assert from 'node:assert/strict'
import {mcpToolFullName} from '@teloa/contract'
import {createIndustryMcpReadiness} from '../src/industry-mcp-readiness.ts'
const definition={format:'teloa.mcp-connection/v1' as const,serverName:'teloa_reference',tools:['read_reference','list_references']}
test('全部声明工具在注册表可见时就绪',async()=>{
 const readiness=createIndustryMcpReadiness(()=>[{name:'mcp__teloa_reference__read_reference'},{name:'mcp__teloa_reference__list_references'},{name:'bash'}],()=>'2026-09-14T00:00:00.000Z')
 assert.deepEqual(await readiness.ready(definition,new AbortController().signal),{ready:true,observedAt:'2026-09-14T00:00:00.000Z'})
})
test('缺任一工具时列出缺失完整名且不就绪',async()=>{
 const readiness=createIndustryMcpReadiness(()=>[{name:'mcp__teloa_reference__read_reference'}],()=>'x')
 assert.deepEqual(await readiness.ready(definition,new AbortController().signal),{ready:false,reason:'缺少工具：mcp__teloa_reference__list_references'})
})
test('已取消信号直接抛出',async()=>{
 const controller=new AbortController();controller.abort()
 await assert.rejects(createIndustryMcpReadiness(()=>[],()=>'x').ready(definition,controller.signal))
})
test('带点号的工具名按 DSH 归一化后的公开名核对就绪，不用简单拼接名',async()=>{
 const lark={format:'teloa.mcp-connection/v1' as const,serverName:'lark',tools:['im.v1.message.list']}
 const publicName=mcpToolFullName('lark','im.v1.message.list')
 assert.notEqual(publicName,'mcp__lark__im.v1.message.list')
 assert.deepEqual(await createIndustryMcpReadiness(()=>[{name:publicName}],()=>'x').ready(lark,new AbortController().signal),{ready:true,observedAt:'x'})
 assert.deepEqual(await createIndustryMcpReadiness(()=>[{name:'mcp__lark__im.v1.message.list'}],()=>'x').ready(lark,new AbortController().signal),{ready:false,reason:'缺少工具：'+publicName})
})
test('mcpToolFullName 与已安装 DSH mcp-client 的 publicToolName 逐字一致（差分核对，DSH 升级改规则时此处失败）',async()=>{
 const {readFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto'),{fileURLToPath}=await import('node:url')
 const source=await readFile(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-mcp-client')),'utf8')
 const pick=(pattern:RegExp)=>{const match=source.match(pattern);assert.ok(match,String(pattern));return match[0]}
 const body=[pick(/const MAX_PUBLIC_NAME_LENGTH = .+;/),pick(/const INVALID_NAME_CHARS = .+;/),pick(/const HASH_LENGTH = .+;/),pick(/function publicToolName\(serverName, rawName\) \{[\s\S]*?\n\}/)].join('\n')
 const dsh=new Function('createHash',body+'\nreturn publicToolName')(createHash) as (server:string,raw:string)=>string
 const cases:[string,string][]=[['lark','im.v1.message.list'],['lark','docx.v1.document.raw_content'],['dingtalk','send_robot_message'],['s','a'.repeat(56)],['s','a'.repeat(57)],['s','a'.repeat(58)],['dingtalk','a'.repeat(60)],['yuque','x.'+'b'.repeat(70)],['w','中文工具'],['teloa_reference','read_reference']]
 for(const [server,raw] of cases)assert.equal(mcpToolFullName(server,raw),dsh(server,raw),server+'/'+raw)
 // 恰好 64 字的干净名走原样分支，65 字起走摘要分支
 assert.equal(mcpToolFullName('s','a'.repeat(56)),'mcp__s__'+'a'.repeat(56))
 assert.notEqual(mcpToolFullName('s','a'.repeat(57)),'mcp__s__'+'a'.repeat(57))
})
