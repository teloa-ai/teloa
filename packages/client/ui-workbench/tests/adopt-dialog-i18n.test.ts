import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {ADOPT_DIALOG_MESSAGE_ROWS} from '../src/client/i18n/locales/adopt-dialog.ts'

const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('接入已有会话弹窗固定文案全部来自词典',async()=>{
  const source=await readFile(new URL('../src/client/AdoptConversationDialog.tsx',import.meta.url),'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,'adopt-dialog-i18n.test.ts'),[])
  assert.match(source,/management\.adopt\(target\.id,t\('adoptDialog\.fallbackTitle'\)\)/)
})

test('接入会话词典按十语顺序提供真实翻译',()=>{
  for(const row of ADOPT_DIALOG_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
  }
  assert.deepEqual(ADOPT_DIALOG_MESSAGE_ROWS.find(row=>row[0]==='adoptDialog.adopt'),[
    'adoptDialog.adopt','加入工作目录','加入工作目錄','Add to work directory','作業一覧に追加','작업 목록에 추가','Thêm vào thư mục công việc','Añadir al directorio de trabajo','Ajouter au répertoire de travail','Zum Arbeitsverzeichnis hinzufügen','Adicionar ao diretório de trabalho',
  ])
  assert.deepEqual(ADOPT_DIALOG_MESSAGE_ROWS.find(row=>row[0]==='adoptDialog.fallbackTitle')?.slice(1,7),[
    '工作会话','工作會話','Work conversation','作業会話','작업 대화','Cuộc trò chuyện công việc',
  ])
})
