import test from 'node:test'
import assert from 'node:assert/strict'
import {issueBusinessDefinitionPreviewReceipt,verifiesBusinessDefinitionPreviewReceipt} from '../src/work/business-definition-preview-receipt.ts'

test('预览回执逐字绑定本人、范围、草案、正文摘要与当前版本',()=>{
 const binding={ownerId:'local:owner',scope:'SOC',draftId:'11111111-1111-4111-8111-111111111111',definitionHash:'a'.repeat(64),currentVersion:3}
 const receipt=issueBusinessDefinitionPreviewReceipt(binding)
 assert.match(receipt,/^[a-f0-9]{64}$/)
 assert.equal(verifiesBusinessDefinitionPreviewReceipt(receipt,binding),true)
 for(const changed of [
  {...binding,ownerId:'local:other'},
  {...binding,scope:'AppSec'},
  {...binding,draftId:'22222222-2222-4222-8222-222222222222'},
  {...binding,definitionHash:'b'.repeat(64)},
  {...binding,currentVersion:4},
 ])assert.equal(verifiesBusinessDefinitionPreviewReceipt(receipt,changed),false)
})
