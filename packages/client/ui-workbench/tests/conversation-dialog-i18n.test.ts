import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {CONVERSATION_DIALOG_MESSAGE_ROWS} from '../src/client/i18n/locales/conversation-dialog.ts'

const url=new URL('../src/client/CreateConversationDialog.tsx',import.meta.url)
const scopeUrl=new URL('../src/client/ConversationScopeDialog.tsx',import.meta.url)
const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('新建工作会话弹窗的固定文案全部来自词典',async()=>{
  const source=await readFile(url,'utf8')
  const scopeSource=await readFile(scopeUrl,'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,'conversation-dialog-i18n.test.ts'),[])
  assert.match(scopeSource,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(scopeSource,'conversation-dialog-i18n.test.ts'),[])
})

test('新建工作会话词典按十语顺序提供真实翻译',()=>{
  for(const row of CONVERSATION_DIALOG_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
  }
  assert.deepEqual(CONVERSATION_DIALOG_MESSAGE_ROWS.find(row=>row[0]==='conversationDialog.title'),[
    'conversationDialog.title','新建工作会话','新建工作會話','Create work conversation','作業会話を作成','작업 대화 만들기','Tạo cuộc trò chuyện công việc','Crear conversación de trabajo','Créer une conversation de travail','Arbeitsunterhaltung erstellen','Criar conversa de trabalho',
  ])
})

test('执行位置使用统一用户术语，路径只作为辅助信息',async()=>{
  const source=await readFile(url,'utf8')
  const dictionary=Object.fromEntries(CONVERSATION_DIALOG_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
  for(const key of ['conversationDialog.description','conversationDialog.otherLocation','conversationDialog.workspace','conversationDialog.recoverOriginal','conversationDialog.select','conversationDialog.loading','conversationDialog.unavailable','conversationDialog.waiting','conversationDialog.empty','conversationDialog.removed','conversationDialog.locked','conversationDialog.manage']){
    assert.match(dictionary[key]??'',/执行位置/,key)
    assert.doesNotMatch(dictionary[key]??'',/运行位置|工作区/,key)
  }
  assert.equal(dictionary['conversationDialog.path'],'本机路径')
  assert.match(source,/workspace\.title/)
  assert.match(source,/conversationDialog\.path/)
  assert.doesNotMatch(source,/>\{row\.title\} · \{row\.path\}</)
})

test('从「更换执行位置」菜单项进入时标题、说明与主按钮换成对应文案，常规新建路径与异常恢复分支不变',async()=>{
  const source=await readFile(url,'utf8')
  const dictionary=Object.fromEntries(CONVERSATION_DIALOG_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
  assert.equal(dictionary['conversationDialog.changeLocationTitle'],'更换执行位置')
  assert.equal(dictionary['conversationDialog.changeLocationDescription'],'仅为本次工作选择已经授权的执行位置。业务会记住成功使用的位置；失效绑定不会自动改用其他目录。')
  assert.equal(dictionary['conversationDialog.useLocation'],'使用此位置')
  assert.match(source,/mode\?:'create'\|'chooseWorkspace'/)
  assert.match(source,/changingLocation\?'conversationDialog\.changeLocationTitle':'conversationDialog\.title'/)
  assert.match(source,/changingLocation\?'conversationDialog\.changeLocationDescription':'conversationDialog\.description'/)
  assert.match(source,/changingLocation\?'conversationDialog\.useLocation':'conversationDialog\.create'/)
  assert.match(source,/conversationDialog\.manage/)
  assert.match(source,/conversationDialog\.locked/)
  assert.match(source,/conversationDialog\.startNew/)
  assert.doesNotMatch(source,/返回/)
})

test('选择会话范围弹层说明带同事名、label 改为会话范围、按钮为开始会话，且不再有占位项',async()=>{
  const dialog=await readFile(scopeUrl,'utf8')
  const dictionary=Object.fromEntries(CONVERSATION_DIALOG_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
  assert.equal(dictionary['conversationDialog.scope'],'会话范围')
  assert.equal(dictionary['conversationDialog.scopeDescription'],'{name} 可在多个业务范围工作。本次会话只绑定一个范围，资料和能力仍按该范围核验。')
  assert.equal(dictionary['conversationDialog.startConversation'],'开始会话')
  assert.match(dialog,/name:string/)
  assert.match(dialog,/conversationDialog\.scopeDescription',\{name\}\)/)
  assert.match(dialog,/conversationDialog\.startConversation/)
  assert.doesNotMatch(dialog,/conversationDialog\.selectScope/)
  assert.doesNotMatch(dialog,/<option value="">/)
})
