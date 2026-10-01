import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('标准 MCP 客户端经 stdio 执行只读工具，成功正文与结构一致，失败不泄露正文',{timeout:20000},async t=>{
  const client=new Client({name:'teloa-protocol-test',version:'1'})
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/main.ts',import.meta.url))],env:{},stderr:'pipe'})
  t.after(()=>client.close())
  await client.connect(transport)
  const tools=await client.listTools()
  assert.deepEqual(tools.tools.map(tool=>tool.name),['list_references','read_reference'])
  assert.ok(tools.tools.every(tool=>tool.annotations?.readOnlyHint===true))
  const listing=await client.callTool({name:'list_references',arguments:{}})
  assert.equal(listing.isError,undefined)
  const content=listing.structuredContent as {schema:string;references:{id:string;version:string}[]}
  assert.equal(content.schema,'teloa.reference-list/v1')
  assert.equal(content.references.length,2)
  const ref=content.references[0]!
  const read=await client.callTool({name:'read_reference',arguments:{id:ref.id,version:ref.version}})
  assert.equal(read.isError,undefined)
  const data=read.structuredContent as {version:string;text:string}
  assert.equal(createHash('sha256').update(data.text).digest('hex'),data.version)
  assert.deepEqual(read.content,[{type:'text',text:JSON.stringify(read.structuredContent)}])
  for(const args of [{id:'../../etc/passwd',version:ref.version},{id:ref.id,version:'0'.repeat(64)},{id:ref.id},{id:ref.id,version:ref.version,path:'/etc/passwd'}]){
    const failure=await client.callTool({name:'read_reference',arguments:args})
    assert.equal(failure.isError,true)
    assert.equal(failure.structuredContent,undefined)
  }
  assert.equal((await client.callTool({name:'list_references',arguments:{path:'/etc'}})).isError,true)
})
