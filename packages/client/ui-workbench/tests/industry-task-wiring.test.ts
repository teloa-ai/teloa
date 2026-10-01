import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('行业来源与执行子树使用不同key命名空间，任务刷新不会残留来源面板',async()=>{
 const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(source,/IndustryTaskSourcePanel key=\{'source-'\+task\.id\}/)
 assert.match(source,/TaskExecutions key=\{'executions-'\+task\.id\}/)
 assert.doesNotMatch(source,/(?:IndustryTaskSourcePanel|TaskExecutions) key=\{task\.id\}/)
})
