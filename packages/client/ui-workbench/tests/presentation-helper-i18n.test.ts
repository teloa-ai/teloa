import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {newApproval,decideApproval,approvalStateKeys} from '../src/client/approval-preview.ts'
import {PRESENTATION_HELPER_MESSAGE_ROWS} from '../src/client/i18n/locales/presentation-helpers.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const at='2026-09-12T00:00:00.000Z'
const approval=()=>newApproval('approval-1',{subjectVersion:1,subjectLabel:'Task',title:'Review',goal:'Check',object:'repo',result:'',evidence:[],risk:'low',effect:'none'},at)

test('approval preview exposes stable status keys and coded validation errors',()=>{
 assert.equal(approvalStateKeys.pending,'approvalCard.status.pending')
 let caught:unknown
 try{decideApproval(approval(),{approvalId:'approval-1',expectedVersion:99,decision:'approved',note:'ok',now:at},1)}catch(error){caught=error}
 assert.equal((caught as {code?:string}).code,'teloa/version-conflict')
 assert.doesNotMatch((caught as Error).message,/[一-鿿]/u)
})

test('presentation helper dictionaries cover all ten main locales',()=>{
 for(const row of PRESENTATION_HELPER_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  for(const value of row.slice(1))assert.ok(value.trim(),row[0])
 }
})

test('member summaries provide a singular saved-role form',()=>{
 const row=PRESENTATION_HELPER_MESSAGE_ROWS.find(item=>item[0]==='presentation.collaboration.membersWithOneSaved')
 assert.equal(row?.[3],"{count} members · {saved} saved employee")
})

test('presentation helpers contain no fixed Chinese UI strings',async()=>{
 const root=new URL('../src/client/',import.meta.url)
 for(const file of ['approval-preview.ts','collaboration-presentation.ts','continuous-directory-presentation.ts','saved-collaboration-state.ts']){
  const source=await readFile(new URL(file,root),'utf8')
  assert.deepEqual(chineseUiLiterals(source,file),[],file)
 }
})
