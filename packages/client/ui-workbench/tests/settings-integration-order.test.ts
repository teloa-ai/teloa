import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const client=new URL('../src/client/',import.meta.url)

test('设置节顺序：IM 通道 order 65，位于智能体预设之后、系统组件之前；使用统计页已移除',async()=>{
 const integration=await readFile(new URL('settings-integration.ts',client),'utf8')
 const table=/const SETTINGS_SECTION_ORDER:[^=]*=\{([^}]*)\}/.exec(integration)?.[1]
 assert.ok(table,'找不到 SETTINGS_SECTION_ORDER')
 const order=Object.fromEntries([...table.matchAll(/'?([A-Za-z-]+)'?:(\d+)/g)].map(match=>[match[1]!,Number(match[2])]))
 assert.equal(order['teloa-im-channels'],65)
 assert.equal(order['teloa-usage-stats'],undefined)
 assert.ok(order['agent-presets']!<order['teloa-im-channels']!)
 assert.ok(order['teloa-im-channels']!<order.plugins!)
 assert.match(integration,/id:'teloa-im-channels'[\s\S]{0,120}label:\(\)=>t\('imChannels\.title'\)/)
})

test('装配根创建 IM 通道 API：走回执 RPC 与独立恢复记录键',async()=>{
 const entry=await readFile(new URL('index.ts',client),'utf8')
 assert.match(entry,/createImChannelsApi\(async\(endpoint,payload\)=>\{const result=await callWithReceipt\(endpoint,payload\)[\s\S]{0,200}journal\('teloa\.im-channels\/v1'\)\)/)
})
