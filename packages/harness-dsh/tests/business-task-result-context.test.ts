import test from 'node:test'
import assert from 'node:assert/strict'
import {businessObjectSnapshotHash} from '../../backend/src/work/business-data.ts'
import {readRunBusinessContext,type RunBusinessContext} from '@teloa/backend'
import {readBusinessObjectTypeDefinition,readBusinessSourceMappingDefinition} from '@teloa/contract'
import {withBusinessTaskResultMappings,fixedBusinessTaskResultMapping,objectResultTool} from '../src/business-task-result-context.ts'

const object={scope:'SOC',type:'case',id:'CASE-1',version:1,title:'原案件',source:'已登记来源',observedAt:'2026-10-12T00:00:00.000Z',receivedAt:'2026-10-12T00:00:00.000Z',quality:'complete' as const,summary:'原始事实',fields:[]}
const context:RunBusinessContext={taskId:'11111111-1111-4111-8111-111111111111',sourceId:'cases',object:{...object,snapshotHash:businessObjectSnapshotHash(object)}}
const mapping=readBusinessSourceMappingDefinition({format:'teloa.business-source-mapping/v1',id:'verdicts',version:'1.0.0',domain:'SOC',title:'研判结果',objectType:'verdict',source:{kind:'role-result'},mapping:[{path:'$.object.id',field:'id'},{path:'$.result.verdict',field:'verdict'}],primaryKey:['id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false})
const objectType=readBusinessObjectTypeDefinition({format:'teloa.business-object-type/v1',id:'verdict',version:'1.0.0',domain:'SOC',title:'研判',unit:'项',lead:'记录研判',sourceId:'results',fields:[{name:'id',type:'text',label:'编号',from:'编号',required:true},{name:'verdict',type:'enum',label:'结论',from:'结论',required:true,values:['恶意','良性']}]})
const target={mapping,objectType,definitionHash:'a'.repeat(64),objectTypeDefinitionHash:'b'.repeat(64)},auth={roleId:'analyst',allowedTools:[objectResultTool],argumentRules:[{name:objectResultTool,anyArguments:true as const,allowed:[]}]}
const run=(value:RunBusinessContext)=>({inputText:JSON.stringify({businessContext:value}),...auth})

test('目录只由固定对象及原工具参数授权导出，通用/未绑定/未授权不读取',async()=>{
 let reads=0;const read=async()=>{reads++;return [target]}
 assert.equal(await withBusinessTaskResultMappings(undefined,auth,read),undefined)
 assert.deepEqual(await withBusinessTaskResultMappings(context,{...auth,allowedTools:[]},read),context)
 assert.equal(reads,0)
 const restricted=await withBusinessTaskResultMappings(context,{...auth,argumentRules:[{name:objectResultTool,allowed:[{mappingId:'other'}]}]},read)
 assert.deepEqual(restricted?.resultMappings,[],'现有精确原始参数规则不能被目录默认值绕过')
 const fixed=await withBusinessTaskResultMappings(context,auth,read)
 assert.deepEqual(fixed?.resultMappings,[target]);assert.deepEqual(readRunBusinessContext(fixed),fixed)
})

test('单目标自动与显式选择共用冻结目录和参数核验，多个/缺目录/改范围拒绝',()=>{
 const fixed={...context,resultMappings:[target]},value=run(fixed)
 assert.equal(fixedBusinessTaskResultMapping(value,undefined,{verdict:'恶意'}).mappingId,mapping.id)
 assert.equal(fixedBusinessTaskResultMapping(value,mapping.id,{verdict:'恶意'}).mappingId,mapping.id)
 assert.throws(()=>fixedBusinessTaskResultMapping(value,'other',{}),{code:'teloa/forbidden'})
 assert.throws(()=>fixedBusinessTaskResultMapping(run(context),undefined,{}),{code:'teloa/forbidden'})
 assert.throws(()=>fixedBusinessTaskResultMapping({...value,allowedTools:[]},undefined,{}),{code:'teloa/forbidden'})
 assert.throws(()=>fixedBusinessTaskResultMapping({...value,argumentRules:[{name:objectResultTool,allowed:[{mappingId:mapping.id}]}]},undefined,{}),{code:'teloa/forbidden'})
 const second={...target,mapping:{...mapping,id:'another-verdict'}}
 assert.throws(()=>fixedBusinessTaskResultMapping(run({...context,resultMappings:[target,second]}),undefined,{}),{code:'teloa/forbidden'})
 assert.equal(fixedBusinessTaskResultMapping(run({...context,resultMappings:[target,second]}),second.mapping.id,{}).mappingId,second.mapping.id)
 assert.throws(()=>readRunBusinessContext({...fixed,resultMappings:[{...target,mapping:{...mapping,domain:'Other'}}]}),{code:'teloa/storage-corrupt'})
 assert.throws(()=>readRunBusinessContext({...fixed,resultMappings:[target,target]}),{code:'teloa/storage-corrupt'})
})

test('续办成果固定到本轮已核验的最后来源版本，原任务版本与旧Run输入保持',()=>{
 const v2={...object,version:2,summary:'本次更新为130元'},v3={...object,version:3,summary:'本次更新为140元'}
 const second={...v2,snapshotHash:businessObjectSnapshotHash(v2)},third={...v3,snapshotHash:businessObjectSnapshotHash(v3)}
 const first=run({...context,resultMappings:[target]}),value=run({...context,updates:[second,third],resultMappings:[target]}),oldText=first.inputText,currentText=value.inputText
 const selected=fixedBusinessTaskResultMapping(value,undefined,{verdict:'恶意'})
 assert.deepEqual(selected.reference,{scope:object.scope,type:object.type,id:object.id,version:3,snapshotHash:third.snapshotHash})
 assert.deepEqual(selected.context.object,context.object,'原Task创建时的固定来源不被新版本覆盖')
 assert.deepEqual(fixedBusinessTaskResultMapping(first,undefined,{verdict:'恶意'}).reference,{scope:object.scope,type:object.type,id:object.id,version:1,snapshotHash:context.object.snapshotHash})
 assert.equal(first.inputText,oldText);assert.equal(value.inputText,currentText)
 assert.throws(()=>fixedBusinessTaskResultMapping(run({...context,updates:[{...second,id:'OTHER'}],resultMappings:[target]}),undefined,{}),{code:'teloa/storage-corrupt'})
 assert.throws(()=>fixedBusinessTaskResultMapping(run({...context,updates:[third,second],resultMappings:[target]}),undefined,{}),{code:'teloa/storage-corrupt'})
 assert.throws(()=>fixedBusinessTaskResultMapping(run({...context,updates:[{...second,snapshotHash:'c'.repeat(64)}],resultMappings:[target]}),undefined,{}),{code:'teloa/storage-corrupt'})
})
