import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {CAPABILITY_BINDINGS_MESSAGE_ROWS} from '../src/client/i18n/locales/capability-bindings.ts'
import {WORK_DIRECTORY_MESSAGE_ROWS} from '../src/client/i18n/locales/work-directory.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

for(const name of ['CapabilityBindings.tsx','WorkDirectory.tsx','ConversationActions.tsx'])test(`${name} 的固定界面文案全部来自词典`,async()=>{
  const source=await readFile(new URL(`../src/client/${name}`,import.meta.url),'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,name),[])
  assert.doesNotMatch(source,/toLocaleString\(['"]zh-CN/)
  assert.doesNotMatch(source,/error instanceof Error\s*\?\s*error\.message/)
})

test('能力绑定与工作目录词典严格提供十套人工翻译',()=>{
  for(const rows of [CAPABILITY_BINDINGS_MESSAGE_ROWS,WORK_DIRECTORY_MESSAGE_ROWS])for(const row of rows){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
  }
  for(const rows of [CAPABILITY_BINDINGS_MESSAGE_ROWS,WORK_DIRECTORY_MESSAGE_ROWS])assert.equal(new Set(rows.map(row=>row[0])).size,rows.length,'词典键不得重复覆盖')
  const capability=new Map(CAPABILITY_BINDINGS_MESSAGE_ROWS.map(row=>[row[0],row]))
  const directory=new Map(WORK_DIRECTORY_MESSAGE_ROWS.map(row=>[row[0],row]))
  assert.deepEqual(capability.get('capability.binding.title')?.slice(1,7),['业务能力绑定','業務能力綁定','Business capability bindings','業務能力の紐付け','업무 기능 바인딩','Liên kết năng lực nghiệp vụ'])
  assert.deepEqual(directory.get('workDirectory.search.placeholder')?.slice(1,7),['搜索名称与正文','搜尋名稱與正文','Search names and content','名前と本文を検索','이름 및 본문 검색','Tìm tên và nội dung'])
})


test('新员工会话与原群关联文案定稿简繁英，香港用语和其他语言英文回退可用',async()=>{
 const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
 assert.equal(translateMessage('zh-CN','conversationDirectory.employeeTitle',{name:'小研'}),'与小研对话')
 assert.equal(translateMessage('zh-Hant','conversationDirectory.employeeTitle',{name:'小研'}),'與小研對話')
 assert.equal(translateMessage('zh-HK','conversationDirectory.employeeTitle',{name:'小研'}),'與小研對話')
 assert.equal(translateMessage('en','conversationDirectory.employeeTitle',{name:'Alice'}),'Chat with Alice')
 assert.equal(translateMessage('ja','conversationDirectory.employeeTitle',{name:'Alice'}),'Chat with Alice')
 assert.equal(translateMessage('zh-CN','project.group.originalLink'),'由原群关联')
 assert.equal(translateMessage('zh-Hant','project.group.originalLink'),'由原群關聯')
 assert.equal(translateMessage('en','project.group.originalLink'),'Linked from the original group')
})
