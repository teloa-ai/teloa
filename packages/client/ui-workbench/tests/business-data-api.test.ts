import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readBusinessDataPage} from '../src/client/business-data-api.ts'

/**
 * `createBusinessDataApi`/`appendBusinessDataPage` 与它们的用例一起删掉了：业务页真实模式改由声明驱动，
 * `business-data/query` 这条分页读取在界面上再没有调用方，只有这份测试在调（复审 MEDIUM-5）。
 * 留下的 `readBusinessDataPage` 仍有真实调用方（`object-conversation-api.ts` 用它核对会话里带出的
 * 那一条对象快照），它的判据因此照旧钉在这里。
 */

const itemBase={scope:'SOC',type:'alert',id:'ALRT-1042',version:3,title:'可疑横向移动',source:'EDR',observedAt:'2026-09-12T00:10:00.000Z',receivedAt:'2026-09-12T00:10:01.000Z',quality:'complete' as const,summary:'同一主机出现异常凭据使用。',fields:[{label:'主机',value:'prod-03'}]}
const item={...itemBase,snapshotHash:createHash('sha256').update(JSON.stringify(itemBase)).digest('hex')}
const page={schema:'teloa.business-data-page/v1' as const,sourceId:'security-alert-http',capturedAt:'2026-09-12T00:10:02.000Z',items:[item],nextCursor:'cursor-2'}

test('回包原样读出来，固定快照的摘要逐条复算',async()=>{
 assert.deepEqual(await readBusinessDataPage(page,{scope:'SOC',sourceId:'security-alert-http'}),page)
 const final={schema:'teloa.business-data-page/v1' as const,sourceId:'security-alert-http',capturedAt:page.capturedAt,items:[]}
 assert.deepEqual(await readBusinessDataPage(final,{scope:'SOC',sourceId:'security-alert-http'}),final,'最终页可以省略游标')
})

test('来源、范围、摘要与重复对象任一条不符即整条拒收',async()=>{
 const expected={scope:'SOC',sourceId:'security-alert-http'}
 await assert.rejects(readBusinessDataPage({...page,sourceId:'other-source'},expected),/格式|来源/)
 await assert.rejects(readBusinessDataPage({...page,items:[{...item,snapshotHash:'a'.repeat(64)}]},expected),/摘要|格式/)
 await assert.rejects(readBusinessDataPage(page,{...expected,scope:'AppSec'}),/范围|格式/,'范围与回包里逐条的 scope 必须一致')
 await assert.rejects(readBusinessDataPage({...page,items:[item,item]},expected),/重复/)
})

test('来源回执可固定非 SOC 业务的对象快照，不回落安全行业来源',async()=>{
 const appsecBase={...itemBase,scope:'AppSec',type:'finding',id:'FIND-1042',source:'Code scanner'}
 const appsecItem={...appsecBase,snapshotHash:createHash('sha256').update(JSON.stringify(appsecBase)).digest('hex')}
 const appsecPage={...page,sourceId:'appsec-finding-http',items:[appsecItem]}
 assert.deepEqual(await readBusinessDataPage(appsecPage,{scope:'AppSec',sourceId:'appsec-finding-http'}),appsecPage)
 await assert.rejects(readBusinessDataPage(appsecPage,{scope:'AppSec',sourceId:'security-alert-http'}),/格式|来源/)
})
