import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {APPROVAL_CARD_MESSAGE_ROWS} from '../src/client/i18n/locales/approval-card.ts'

const url=new URL('../src/client/ApprovalCard.tsx',import.meta.url)
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('审批卡固定文案与日期格式全部使用当前语言',async()=>{
  const source=await readFile(url,'utf8')
  assert.match(source,/useI18n\(/)
  assert.doesNotMatch(source,/toLocaleString\('zh-CN'/)
  assert.deepEqual(chineseUiLiterals(source,'approval-card-i18n.test.ts'),[])
})

test('审批卡词典按十语顺序提供真实翻译',()=>{
  for(const row of APPROVAL_CARD_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
  }
  assert.deepEqual(APPROVAL_CARD_MESSAGE_ROWS.find(row=>row[0]==='approvalCard.status.pending'),[
    'approvalCard.status.pending','待审批','待審批','Pending approval','承認待ち','승인 대기','Chờ phê duyệt','Pendiente de aprobación','En attente d’approbation','Genehmigung ausstehend','Aprovação pendente',
  ])
})
