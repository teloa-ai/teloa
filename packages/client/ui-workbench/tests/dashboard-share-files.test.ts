import test from 'node:test'
import assert from 'node:assert/strict'
import type {BusinessDashboardShareSnapshot} from '@teloa/contract'
import {dashboardShareCsv,dashboardShareFilename,dashboardShareCsvMaxBytes} from '../src/client/dashboard-share-files.ts'

const target={kind:'configuration' as const,scope:'SOC',pageId:'overview',configurationVersion:2,configurationHash:'a'.repeat(64),timeRange:'7d' as const}
function snapshot(rows:(string|null)[][]):BusinessDashboardShareSnapshot{return {
 target,capturedAt:'2026-10-21T10:00:00.000Z',snapshotHash:'b'.repeat(64),
 raw:{status:'ready',sections:[{widgetId:'count',viewId:'tickets',objectTypeId:'ticket',columns:[{key:'record.id',label:'记录'},{key:'field.note',label:'备注'}],rows,recordCount:rows.length}]},
} as BusinessDashboardShareSnapshot}

test('CSV包含全部原始记录、固定范围和来源，保留逗号换行并防止表格公式执行',async()=>{
 const value=snapshot(Array.from({length:55},(_,i)=>['record-'+i,i===0?'原始,"正文"\n第二行':i===1?'=HYPERLINK("https://example.invalid")':i===2?'-12.50':null]))
 const blob=dashboardShareCsv(value),bytes=new Uint8Array(await blob.arrayBuffer()),text=await blob.text()
 assert.deepEqual([...bytes.slice(0,3)],[0xef,0xbb,0xbf])
 assert.match(text,/'=HYPERLINK/);assert.match(text,/"-12.50"/)
 assert.match(text,/"原始,""正文""\n第二行"/)
 assert.match(text,/"SOC","overview","2","7d","2026-10-21T10:00:00.000Z"/)
 assert.match(text,/record-54/)
 assert.equal((text.match(/"record-\d+"/g)??[]).length,55,'不能沿用页面50行展示上限截断原始CSV')
 assert.equal(value.raw.status==='ready'&&value.raw.sections[0]?.rows[1]?.[1],'=HYPERLINK("https://example.invalid")','转义只发生在导出文件，不改来源记录')
})

test('不同源列合并成一个有效CSV列集，不把缺值填成零或跨类型覆盖',async()=>{
 const value=snapshot([['one','note']])
 if(value.raw.status!=='ready')throw Error()
 value.raw.sections.push({widgetId:'amount',viewId:'orders',objectTypeId:'order',columns:[{key:'record.id',label:'记录'},{key:'field.amount',label:'金额'}],rows:[['two','{"decimal":"1.2300","currency":"USD"}']],recordCount:1})
 const text=await dashboardShareCsv(value).text()
 assert.match(text,/"record.id","field.note","field.amount"/)
 assert.match(text,/"one","note",""/)
 assert.match(text,/"two","","\{""decimal"":""1.2300"",""currency"":""USD""\}"/)
})

test('无原始来源、损坏行、超过总行数及字节上限均明确拒绝，文件名固定同一快照',()=>{
 assert.throws(()=>dashboardShareCsv({...snapshot([]),raw:{status:'unavailable',reason:'sql-source-lineage-unavailable'}}),{code:'teloa/dashboard-share-no-raw'})
 const invalid=snapshot([['one']]);assert.throws(()=>dashboardShareCsv(invalid),{code:'teloa/invalid-host-response'})
 assert.throws(()=>dashboardShareCsv(snapshot(Array.from({length:5001},()=>['id','value']))),{code:'teloa/dashboard-share-limit'})
 assert.throws(()=>dashboardShareCsv(snapshot([['id','x'.repeat(dashboardShareCsvMaxBytes)]])),{code:'teloa/dashboard-share-limit'})
 assert.equal(dashboardShareFilename(snapshot([]),'csv'),'dashboard-overview-7d-bbbbbbbbbbbb.csv')
})

