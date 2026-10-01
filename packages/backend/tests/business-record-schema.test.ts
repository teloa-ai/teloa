import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {businessDefinitionCanonicalBody,readBusinessObjectTypeDefinitionVersioned} from '@teloa/contract'
import {BusinessRecordService} from '../src/work/business-records.ts'
import {businessRecordSchemaFingerprint,businessRecordImportWriteSchemaFingerprint} from '../src/work/business-record-schema.ts'
import type {Pool,PoolClient} from 'pg'

const basic={name:'state',label:'状态',type:'enum',required:true,from:'状态',values:['新建','完成']}
const money={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'金额',currencies:['CNY','SGD']}
const relation={name:'related',label:'关联',type:'reference',required:false,from:'关联',referenceType:'customer'}
const base={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:'SOC',title:'客户',unit:'位',lead:'客户跟进',sourceId:'records',fields:[basic,money,relation],constraints:{uniqueFields:['state','amount']}}
const definition=(value:unknown=base)=>readBusinessObjectTypeDefinitionVersioned(value)
const full=(value:unknown=base)=>businessRecordSchemaFingerprint(definition(value))
const write=(value:unknown=base)=>businessRecordImportWriteSchemaFingerprint(definition(value))

test('完整定义指纹复用既有canonical正文且保留v1/v2差别',()=>{
 assert.equal(full(),createHash('sha256').update(businessDefinitionCanonicalBody(definition())).digest('hex'))
 const v1={...base,format:'teloa.business-object-type/v1',fields:[basic,relation]};delete (v1 as Partial<typeof v1>).constraints
 assert.notEqual(full(v1),full({...v1,format:'teloa.business-object-type/v2'}))
 assert.notEqual(write(v1),write({...v1,format:'teloa.business-object-type/v2'}))
})
test('display_rename_changes_guard_but_not_write_fingerprint',()=>{
 const metadata=(original:string,en:string)=>({original,defaultLocale:'en',locales:{'zh-CN':original,en}})
 for(const revised of [{...base,title:'客户档案'},{...base,version:'1.1.0'},{...base,unit:'条',lead:'新版说明'},{...base,localized:{title:metadata('客户','Customers')}},{...base,fields:[{...basic,label:'进度'},money,relation]},{...base,fields:[{...basic,localized:{label:metadata('状态','Status')}},money,relation]}]){
  assert.notEqual(full(),full(revised));assert.equal(write(),write(revised))
 }
})
test('schema_v2_fingerprint_changes_on_currency_unique_or_reference_target',()=>{
 for(const revised of [{...base,fields:[basic,{...money,currencies:['CNY']},relation]},{...base,constraints:{uniqueFields:['state']}},{...base,fields:[basic,money,{...relation,referenceType:'article'}]}]){
  assert.notEqual(full(),full(revised));assert.notEqual(write(),write(revised))
 }
})
test('写入摘要排序字段与唯一约束但保留声明数组顺序和写入路径',()=>{
 // 此值来自手工投影的canonical字符串，防止域分隔或投影结构发生漂移。
 assert.equal(write(),'601067e9f98fecd61de840fc23310cc802718fb20fcdee1d119b963c12a2c97e')
 assert.equal(write(),write({...base,fields:[relation,money,basic],constraints:{uniqueFields:['amount','state']}}))
 for(const revised of [{...base,fields:[{...basic,from:'新状态'},money,relation]},{...base,fields:[{...basic,required:false},money,relation]},{...base,fields:[{...basic,values:['完成','新建']},money,relation]},{...base,fields:[basic,{...money,currencies:['SGD','CNY']},relation]},{...base,sourceId:'other-records'}])assert.notEqual(write(),write(revised))
 const noConstraints={...base};delete (noConstraints as Partial<typeof base>).constraints
 assert.notEqual(write(),write(noConstraints))
})

function guardFixture(){
 const queries:Array<{sql:string;values:unknown[]}>=[]
 const db={query:async(sql:string,values:unknown[]=[])=>{queries.push({sql,values});return {rows:[],rowCount:0}}} as unknown as PoolClient
 const unavailable=async():Promise<never>=>{throw Error('守卫拒绝前不得准备、写入或连接事务')}
 const dependencies={definitions:{forScope:unavailable,forScopeVersioned:async()=>[{origin:{kind:'local-configuration'},sources:new Map([['records',{}]]),objectTypes:[{definition:definition()}]}]},warehouse:{assertQuota:unavailable},references:{pinInTransaction:unavailable}} as unknown as ConstructorParameters<typeof BusinessRecordService>[2]
 const records=new BusinessRecordService({connect:unavailable} as unknown as Pool,{now:()=>new Date().toISOString()},dependencies)
 const actor={ownerId:'test-owner',scopeIds:['SOC']},input={requestId:'ed8c27f8-6ebc-4f88-b849-a0a84bc8f03b',scope:'SOC',operations:[{operation:'create',type:'customer',title:'测试客户',summary:'',fields:[{name:'state',value:'新建'}]}]}
 return {records,db,actor,input,queries}
}
test('定义漂移在request与configuration锁后拒绝，尚未取得type或head锁且无事务控制',async()=>{
 const f=guardFixture()
 assert.equal(typeof f.records.batchInTransaction,'function','必须提供调用方PoolClient批次原语')
 await assert.rejects(f.records.batchInTransaction(f.db,f.actor,f.input,undefined,{scope:'SOC',type:'customer',schemaFingerprint:'0'.repeat(64)}),{code:'teloa/version-conflict'})
 assert.equal(f.queries.filter(row=>row.sql.includes('pg_advisory_xact_lock(')).length,2)
 assert.equal(f.queries.at(-1)!.sql,'select pg_advisory_xact_lock_shared(hashtextextended($1,0))')
 assert.ok(f.queries.every(row=>!/^begin|^commit|^rollback|^insert|^update|^delete/.test(row.sql)))
 assert.ok(f.queries.every(row=>!row.values.some(value=>typeof value==='string'&&value.includes('teloa.business-record-type'))))
})
test('guard严格拒绝未知字段、非规范hash及与批次不一致的scope或type',async()=>{
 const bad=[null,{}, {scope:'general',type:'customer',schemaFingerprint:'0'.repeat(64)},{scope:'SOC',type:'other',schemaFingerprint:'0'.repeat(64)},{scope:'SOC',type:'customer',schemaFingerprint:'A'.repeat(64)},{scope:'SOC',type:'customer',schemaFingerprint:'0'.repeat(64),ownerId:'another'}]
 for(const expected of bad){
  const f=guardFixture()
  assert.equal(typeof f.records.batchInTransaction,'function','必须提供调用方PoolClient批次原语')
  await assert.rejects(f.records.batchInTransaction(f.db,f.actor,f.input,undefined,expected as never),{code:'teloa/invalid-input'})
  assert.equal(f.queries.length,0)
 }
 const f=guardFixture()
 await assert.rejects(f.records.batchInTransaction(f.db,{...f.actor,scopeIds:[]},f.input),{code:'teloa/forbidden'})
 assert.equal(f.queries.length,0)
})
