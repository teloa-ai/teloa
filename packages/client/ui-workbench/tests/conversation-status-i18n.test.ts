import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {CONVERSATION_STATUS_MESSAGE_ROWS} from '../src/client/i18n/locales/conversation-status.ts'

const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('会话状态使用并列标签且不再硬编码旧文案',async()=>{
  const [source,index]=await Promise.all([
    readFile(new URL('../src/client/Capabilities.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/index.ts',import.meta.url),'utf8'),
  ])
  const bindingStatus=source.slice(source.indexOf('export function BindingStatus'),source.indexOf('export function CapabilitiesToolCard'))
  assert.match(bindingStatus,/useSyncExternalStore\(i18n\.subscribe,i18n\.getSnapshot\)/)
  assert.doesNotMatch(bindingStatus,/conversationStatus\.workScope/)
  assert.doesNotMatch(bindingStatus,/conversationStatus\.capabilityScope/)
  assert.doesNotMatch(bindingStatus,/通用 · 本人工作会话|知识与能力按当前会话提供/)
  assert.match(index,/id:'teloa-binding'[\s\S]*?inject:\(\)=>\(\{work,i18n:requireI18n\(\)\}\)/)
})

test('BindingStatus 就绪态去重，范围与核验说明回归知识与能力面板',async()=>{
  const source=await readFile(new URL('../src/client/Capabilities.tsx',import.meta.url),'utf8')
  const bindingStatus=source.slice(source.indexOf('export function BindingStatus'),source.indexOf('export function CapabilitiesToolCard'))
  assert.doesNotMatch(bindingStatus,/conversationStatus\.workScope/)
  assert.match(bindingStatus,/if\(state\.status==='ready'&&pendingAttachments===0\)return null/)
  const capabilitiesSection=source.slice(source.indexOf('export function Capabilities('),source.indexOf('function ConnectionCatalog'))
  assert.match(capabilitiesSection,/t\('conversationStatus\.capabilityScope'\)/)
})

test('会话状态词典为十套主语言提供完整人工翻译',()=>{
  assert.equal(CONVERSATION_STATUS_MESSAGE_ROWS.length,1)
  for(const row of CONVERSATION_STATUS_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
  }
  const rows=new Map(CONVERSATION_STATUS_MESSAGE_ROWS.map(row=>[row[0],row]))
  assert.deepEqual(rows.get('conversationStatus.capabilityScope')?.slice(1),[
    '按本会话核验',
    '依本次對話核驗',
    'Verified for this conversation',
    'この会話で確認済み',
    '이 대화에서 확인됨',
    'Đã xác minh trong cuộc trò chuyện này',
    'Verificado para esta conversación',
    'Vérifié pour cette conversation',
    'Für dieses Gespräch geprüft',
    'Verificado para esta conversa',
  ])
  for(const row of CONVERSATION_STATUS_MESSAGE_ROWS){
    for(const value of row.slice(1))assert.doesNotMatch(value,/知识与能力|Knowledge and capabilities/)
  }
})
