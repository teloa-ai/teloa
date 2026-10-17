import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {readPendingMarketContents} from '../src/client/pending-market-content.ts'
import type {MarketItem} from '../src/client/market-preview.ts'

const row=(id:string)=>({id:'directory-'+'a'.repeat(64),kind:'bundle',version:'1',hash:'a'.repeat(64),contentStorage:{contentId:id,createdAt:'2026-10-16T00:00:00.000Z',loaded:false}} as MarketItem)
test('冷启动只读补齐原请求固定内容，不用同hash旧声明代替且不提交恢复',async()=>{
 let reads=0
 const api={list:async()=>{reads++;return [row('old-content'),row('required-content'),row('unrelated')]}}
 assert.equal(await readPendingMarketContents(api,[],()=>true),undefined);assert.equal(reads,0)
 const result=await readPendingMarketContents(api,['required-content','required-content'],()=>true)
 assert.deepEqual(result?.map(item=>item.contentStorage?.contentId),['required-content']);assert.equal(reads,1)
 await assert.rejects(readPendingMarketContents({list:async()=>[row('old-content')]},['required-content'],()=>true),/固定来源尚未读到/)
})
test('请求或连接代际已变化时丢弃迟到目录，读失败仍拒绝并可经原入口重读',async()=>{
 let release!:(rows:MarketItem[])=>void,current=true,reads=0
 const delayed={list:()=>new Promise<MarketItem[]>(resolve=>{reads++;release=resolve})}
 const pending=readPendingMarketContents(delayed,['required-content'],()=>current)
 current=false;release([row('required-content')]);assert.equal(await pending,undefined)
 assert.equal(await readPendingMarketContents(delayed,['required-content'],()=>current),undefined);assert.equal(reads,1)
 const unavailable={list:async()=>{throw Error('Connection unavailable')}}
 await assert.rejects(readPendingMarketContents(unavailable,['required-content'],()=>true),/Connection unavailable/)
 assert.equal((await readPendingMarketContents({list:async()=>[row('required-content')]},['required-content'],()=>true))?.length,1)
})
test('工作台冷恢复补齐绑定原请求与API代际，失败使需要你未知且重试不自动恢复提交',async()=>{
 const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 const start=frame.indexOf('const pendingMarketKey='),end=frame.indexOf('// 需要你里点任务类事项',start),body=frame.slice(start,end)
 assert.match(body,/industryRequest\?\.contentId,skillContentId/)
 assert.match(body,/context\.marketContentApi===pendingMarketReadContext\.current\.marketContentApi/)
 assert.match(body,/context\.industryLoadApi===pendingMarketReadContext\.current\.industryLoadApi/)
 assert.match(body,/context\.skillInstallApi===pendingMarketReadContext\.current\.skillInstallApi/)
 assert.match(body,/context\.key===currentKey\(\)/)
 assert.match(body,/generation===pendingMarketReadGeneration\.current/)
 assert.match(body,/catch\(\(\)=>\{if\(isCurrent\(\)\)setPendingMarketReadFailure/)
 assert.match(body,/known:pendingMarketKnown&&/)
 assert.match(body,/retryAttention=\(\)=>\{retryPendingMarketRead/)
 assert.doesNotMatch(body,/\.recover\(|\.create\(|\.install\(/)
})
