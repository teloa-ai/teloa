import test from 'node:test'
import assert from 'node:assert/strict'
import {
 readBusinessReassignmentSelection,readBusinessReassignmentInstruction,
 readBusinessReassignmentSnapshot,readBusinessReassignmentReceipt,
 canonicalBusinessReassignmentSnapshot,
} from '../src/index.ts'

const oldRequestId='abcdefab-1234-4123-8123-abcdefabcdef'
const requestId='bcdefabc-1234-4123-8123-bcdefabcdefa'
const oldRoleId='cdefabcd-1234-4123-8123-cdefabcdefab'
const newRoleId='defabcde-1234-4123-8123-defabcdefabc'
const hash='a'.repeat(64)
const selection={oldRequestId,newRoleId,expectedNewRoleVersion:3}
const instruction={requestId,sessionId:'daily-new',messageId:'本人消息:1',messageSeq:0,sourceText:'请改派给新同事。',selection}
const reference={scope:'crm',type:'customer',id:'customer-1',version:2,snapshotHash:'b'.repeat(64)}
const snapshot={
 instruction,oldSessionId:'daily-old',scope:'crm',
 oldContext:{version:1,roleId:oldRoleId},newContext:{version:2,roleId:null},
 oldTarget:{roleId:oldRoleId,roleVersion:1,name:'原同事'},
 oldRoleCurrent:{version:5,state:'retired' as const},
 newTarget:{roleId:newRoleId,roleVersion:3,name:'新同事'},
 responsibility:{version:0,roleId:null},title:'调查客户',goal:'完成调查并提交结果',
 sourceText:'原始客户材料。',reference,snapshotHash:hash,
}
const receipt={oldRequestId,newRequestId:requestId,oldSessionId:'daily-old',newSessionId:'daily-new',scope:'crm',snapshotHash:hash,createdAt:'2026-09-30T00:00:00.000Z'}
const invalid={code:'teloa/invalid-input'}

test('readers_reject_malformed_roots_missing_required_fields_and_invalid_responsibility',()=>{
 for(const reader of [readBusinessReassignmentSelection,readBusinessReassignmentInstruction,readBusinessReassignmentSnapshot,readBusinessReassignmentReceipt]){
  for(const value of [null,undefined,[],true,'input',{}])assert.throws(()=>reader(value),invalid)
 }
 for(const [reader,input] of [
  [readBusinessReassignmentSelection,selection],
  [readBusinessReassignmentInstruction,instruction],
  [readBusinessReassignmentSnapshot,snapshot],
  [readBusinessReassignmentReceipt,receipt],
 ] as const){
  for(const key of Object.keys(input)){
   if(key==='sourceText'&&reader===readBusinessReassignmentSnapshot||key==='reference')continue
   const missing:Record<string,unknown>={...input}
   delete missing[key]
   assert.throws(()=>reader(missing),invalid)
  }
 }
 for(const value of [-1,0.1,2147483648,'1',null,undefined])assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,responsibility:{version:value,roleId:null}}),invalid)
})

test('reject_extra_identity_and_goal_fields',()=>{
 for(const key of ['oldSessionId','title','goal','reference','owner','snapshotHash','evidence']){
  assert.throws(()=>readBusinessReassignmentSelection({...selection,[key]:'injected'}),invalid)
  assert.throws(()=>readBusinessReassignmentInstruction({...instruction,[key]:'injected'}),invalid)
 }
 assert.throws(()=>readBusinessReassignmentInstruction({...instruction,selection:{...selection,owner:'other'}}),invalid)
})

test('canonicalize_request_and_role_uuids',()=>{
 assert.deepEqual(readBusinessReassignmentSelection({...selection,oldRequestId:oldRequestId.toUpperCase(),newRoleId:newRoleId.toUpperCase()}),selection)
 assert.deepEqual(readBusinessReassignmentInstruction({...instruction,requestId:requestId.toUpperCase(),selection:{...selection,newRoleId:newRoleId.toUpperCase()}}),instruction)
 const mixed={...snapshot,oldContext:{version:1,roleId:oldRoleId.toUpperCase()},oldTarget:{...snapshot.oldTarget,roleId:oldRoleId.toUpperCase()},newTarget:{...snapshot.newTarget,roleId:newRoleId.toUpperCase()},responsibility:{version:1,roleId:newRoleId.toUpperCase()}}
 assert.deepEqual(readBusinessReassignmentSnapshot(mixed),{...snapshot,responsibility:{version:1,roleId:newRoleId}})
 assert.deepEqual(readBusinessReassignmentReceipt({...receipt,oldRequestId:oldRequestId.toUpperCase(),newRequestId:requestId.toUpperCase()}),receipt)
 for(const value of ['bad','00000000-0000-0000-0000-000000000000',`${newRoleId} `])assert.throws(()=>readBusinessReassignmentSelection({...selection,newRoleId:value}),invalid)
})

test('reject_invalid_versions_and_seq',()=>{
 for(const value of [0,-1,1.5,2147483648,'3',null,undefined]){
  assert.throws(()=>readBusinessReassignmentSelection({...selection,expectedNewRoleVersion:value}),invalid)
  assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,oldContext:{version:value,roleId:null}}),invalid)
  assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,newContext:{version:value,roleId:null}}),invalid)
  assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,oldTarget:{...snapshot.oldTarget,roleVersion:value}}),invalid)
  assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,oldRoleCurrent:{version:value,state:'paused'}}),invalid)
 }
 for(const value of [-1,0.1,Number.MAX_SAFE_INTEGER+1,'0',null,undefined])assert.throws(()=>readBusinessReassignmentInstruction({...instruction,messageSeq:value}),invalid)
 assert.equal(readBusinessReassignmentInstruction({...instruction,messageSeq:Number.MAX_SAFE_INTEGER}).messageSeq,Number.MAX_SAFE_INTEGER)
 assert.equal(readBusinessReassignmentSelection({...selection,expectedNewRoleVersion:2147483647}).expectedNewRoleVersion,2147483647)
})

test('selection_requires_real_role_version_and_distinct_request_identity',()=>{
 assert.throws(()=>readBusinessReassignmentSelection({oldRequestId,newRoleId}),invalid)
 assert.throws(()=>readBusinessReassignmentInstruction({...instruction,requestId:oldRequestId.toUpperCase()}),invalid)
 for(const key of ['sessionId','messageId','sourceText'])for(const value of ['',null,undefined])assert.throws(()=>readBusinessReassignmentInstruction({...instruction,[key]:value}),invalid)
 assert.throws(()=>readBusinessReassignmentInstruction({...instruction,sessionId:'daily/new'}),invalid)
 assert.throws(()=>readBusinessReassignmentInstruction({...instruction,sessionId:'a'.repeat(129)}),invalid)
 assert.throws(()=>readBusinessReassignmentInstruction({...instruction,messageId:'a'.repeat(201)}),invalid)
 assert.throws(()=>readBusinessReassignmentInstruction({...instruction,sourceText:'a'.repeat(7401)}),invalid)
})

test('snapshot_accepts_same_and_cross_daily_and_distinct_historical_role_state',()=>{
 assert.deepEqual(readBusinessReassignmentSnapshot(snapshot),snapshot)
 assert.equal(readBusinessReassignmentSnapshot({...snapshot,oldSessionId:instruction.sessionId}).oldSessionId,instruction.sessionId)
 for(const state of ['active','paused','retired'] as const)assert.equal(readBusinessReassignmentSnapshot({...snapshot,oldRoleCurrent:{version:5,state}}).oldRoleCurrent?.state,state)
 assert.equal(readBusinessReassignmentSnapshot({...snapshot,oldRoleCurrent:null}).oldRoleCurrent,null)
 // 角色是否可改派属于服务端当前语义；协议允许本人明确重选同一角色及新版本。
 assert.equal(readBusinessReassignmentSnapshot({...snapshot,oldTarget:{...snapshot.oldTarget,roleId:newRoleId}}).oldTarget.roleId,newRoleId)
 const clearedResponsibility=readBusinessReassignmentSnapshot({...snapshot,responsibility:{version:3,roleId:null}}).responsibility
 assert.ok(clearedResponsibility!==null)
 assert.equal(clearedResponsibility.version,3)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,responsibility:{version:0,roleId:oldRoleId}}),invalid)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,oldRoleCurrent:{version:5,state:'missing'}}),invalid)
})

test('unmanaged_null_responsibility_is_distinct_from_managed_unassigned_in_reader_and_canonical',()=>{
 const unmanaged={...snapshot,responsibility:null}
 assert.deepEqual(readBusinessReassignmentSnapshot(unmanaged),unmanaged)
 assert.equal(readBusinessReassignmentSnapshot(snapshot).responsibility?.version,0)
 const {snapshotHash:_managedHash,...managedBody}=snapshot
 const {snapshotHash:_unmanagedHash,...unmanagedBody}=unmanaged
 const managedCanonical=canonicalBusinessReassignmentSnapshot(managedBody)
 const unmanagedCanonical=canonicalBusinessReassignmentSnapshot(unmanagedBody)
 assert.notEqual(unmanagedCanonical,managedCanonical)
 assert.equal(unmanagedCanonical.includes('"responsibility":null'),true)
 assert.equal(managedCanonical.includes('"responsibility":{"version":0,"roleId":null}'),true)
 for(const value of [undefined,{},[],{version:0},{roleId:null},{version:0,roleId:null,managed:false}])assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,responsibility:value}),invalid)
})

test('snapshot_rejects_unaligned_target_reference_scope_and_unknown_nested_fields',()=>{
 for(const value of [
  {...snapshot,newTarget:{...snapshot.newTarget,roleId:oldRoleId}},
  {...snapshot,newTarget:{...snapshot.newTarget,roleVersion:2}},
  {...snapshot,scope:'general'}, {...snapshot,scope:'x'.repeat(65)},
  {...snapshot,reference:{...reference,scope:'other'}},
  {...snapshot,snapshotHash:hash.toUpperCase()}, {...snapshot,snapshotHash:'a'.repeat(63)},
  {...snapshot,owner:'other'}, {...snapshot,oldContext:{...snapshot.oldContext,locked:true}},
  {...snapshot,newContext:{...snapshot.newContext,owner:'other'}},
  {...snapshot,oldTarget:{...snapshot.oldTarget,scope:'other'}},
  {...snapshot,newTarget:{...snapshot.newTarget,state:'active'}},
  {...snapshot,oldRoleCurrent:{...snapshot.oldRoleCurrent,roleId:oldRoleId}},
  {...snapshot,responsibility:{...snapshot.responsibility,selectedRoleVersion:1}},
  {...snapshot,reference:{...reference,title:'injected'}},
  {...snapshot,reference:{...reference,version:0}},
  {...snapshot,oldContext:{version:1,roleId:'bad'}},
 ])assert.throws(()=>readBusinessReassignmentSnapshot(value),invalid)
 for(const key of ['title','goal'])assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,[key]:' '}),invalid)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,title:'a'.repeat(121)}),invalid)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,goal:'a'.repeat(8001)}),invalid)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,oldTarget:{...snapshot.oldTarget,name:'a'.repeat(121)}}),invalid)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,newTarget:{...snapshot.newTarget,name:''}}),invalid)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,sourceText:'a'.repeat(7400)}),invalid)
})

test('receipt_matches_both_request_ids_and_allows_same_or_cross_session',()=>{
 assert.deepEqual(readBusinessReassignmentReceipt(receipt),receipt)
 assert.equal(readBusinessReassignmentReceipt({...receipt,newSessionId:receipt.oldSessionId}).newSessionId,receipt.oldSessionId)
 for(const value of [
  {...receipt,newRequestId:oldRequestId.toUpperCase()}, {...receipt,oldRequestId:'bad'},
  {...receipt,newRequestId:undefined}, {...receipt,newSessionId:'bad/session'},
  {...receipt,oldSessionId:''}, {...receipt,scope:'general'}, {...receipt,snapshotHash:'A'.repeat(64)},
  {...receipt,createdAt:'invalid'}, {...receipt,createdAt:'2026-09-30'}, {...receipt,owner:'other'},
 ])assert.throws(()=>readBusinessReassignmentReceipt(value),invalid)
})

test('canonical_snapshot_has_fixed_nested_key_order_and_does_not_mix_sources',()=>{
 const {snapshotHash:_snapshotHash,...input}=snapshot
 const expected='{"instruction":{"requestId":"bcdefabc-1234-4123-8123-bcdefabcdefa","sessionId":"daily-new","messageId":"本人消息:1","messageSeq":0,"sourceText":"请改派给新同事。","selection":{"oldRequestId":"abcdefab-1234-4123-8123-abcdefabcdef","newRoleId":"defabcde-1234-4123-8123-defabcdefabc","expectedNewRoleVersion":3}},"oldSessionId":"daily-old","scope":"crm","oldContext":{"version":1,"roleId":"cdefabcd-1234-4123-8123-cdefabcdefab"},"newContext":{"version":2,"roleId":null},"oldTarget":{"roleId":"cdefabcd-1234-4123-8123-cdefabcdefab","roleVersion":1,"name":"原同事"},"oldRoleCurrent":{"version":5,"state":"retired"},"newTarget":{"roleId":"defabcde-1234-4123-8123-defabcdefabc","roleVersion":3,"name":"新同事"},"responsibility":{"version":0,"roleId":null},"title":"调查客户","goal":"完成调查并提交结果","sourceText":"原始客户材料。","reference":{"scope":"crm","type":"customer","id":"customer-1","version":2,"snapshotHash":"'+ 'b'.repeat(64)+'"}}'
 assert.equal(canonicalBusinessReassignmentSnapshot(input),expected)
 const reorder=(value:unknown):unknown=>{
  if(value===null||typeof value!=='object'||Array.isArray(value))return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key,entry])=>[key,reorder(entry)]))
 }
 assert.equal(canonicalBusinessReassignmentSnapshot(reorder(input) as typeof input),expected)
 const shuffled=readBusinessReassignmentSnapshot(reorder(snapshot))
 const {snapshotHash:_shuffledHash,...shuffledInput}=shuffled
 assert.equal(canonicalBusinessReassignmentSnapshot(shuffledInput),expected)
 assert.throws(()=>canonicalBusinessReassignmentSnapshot({...input,owner:'other'} as typeof input),invalid)
 assert.throws(()=>canonicalBusinessReassignmentSnapshot({...input,snapshotHash:hash} as typeof input),invalid)
})

test('canonical_snapshot_omits_missing_optional_fields_and_rejects_null',()=>{
 const {snapshotHash:_snapshotHash,sourceText:_sourceText,reference:_reference,...input}=snapshot
 const canonical=canonicalBusinessReassignmentSnapshot(input)
 const parsed:unknown=JSON.parse(canonical)
 assert.ok(parsed!==null&&typeof parsed==='object')
 assert.equal(Object.hasOwn(parsed,'sourceText'),false)
 assert.equal(Object.hasOwn(parsed,'reference'),false)
 assert.equal(canonicalBusinessReassignmentSnapshot({...input,oldRoleCurrent:null}).includes('"oldRoleCurrent":null'),true)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,sourceText:null}),invalid)
 assert.throws(()=>readBusinessReassignmentSnapshot({...snapshot,reference:null}),invalid)
})
