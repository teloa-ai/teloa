import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {KNOWLEDGE_DOCUMENT_MESSAGE_ROWS} from '../src/client/i18n/locales/knowledge-document.ts'

for(const name of ['KnowledgeDocument.tsx','KnowledgeMarkdownEditor.tsx','ResourceHistory.tsx'])test(`${name} 固定界面文案与日期格式使用当前语言`,async()=>{
  const source=await readFile(new URL(`../src/client/${name}`,import.meta.url),'utf8')
  assert.match(source,/useI18n\(/)
  assert.doesNotMatch(source,/toLocaleString\('zh-CN'/)
  assert.deepEqual(chineseUiLiterals(name,source),[])
})

const knowledgeRow=(key:string)=>{
  const row=KNOWLEDGE_DOCUMENT_MESSAGE_ROWS.find(item=>item[0]===key)
  assert.ok(row,`missing ${key}`)
  return row
}
const localized=(key:string,column:number)=>{
  const value=knowledgeRow(key)[column]
  assert.ok(value,`missing ${key} locale column ${column}`)
  return value
}

test('知识文档保存、锁定引用与消息轮次使用准确的产品术语',()=>{
  assert.deepEqual(knowledgeRow('knowledge.ui.043').slice(2,7),['正在儲存…','Saving…','保存中…','저장 중…','Đang lưu…'])
  assert.deepEqual(knowledgeRow('knowledge.ui.084').slice(2,7),[
    '記錄保留當時的名稱和版本，不代表資料現在仍可用。檔案、圖片與技能繼續在原生訊息中查看。',
    'Records retain the names and versions captured at the time; this does not mean the materials are still available. Continue viewing files, images, and Skills in the original message.',
    '記録には当時の名前とバージョンが保持されますが、資料が現在も利用可能であることを意味しません。ファイル、画像、スキルは元のメッセージで引き続き確認できます。',
    '기록에는 당시의 이름과 버전이 보존되며, 자료를 지금도 사용할 수 있다는 의미는 아닙니다. 파일, 이미지 및 스킬은 원본 메시지에서 계속 확인할 수 있습니다.',
    'Bản ghi giữ lại tên và phiên bản tại thời điểm đó; điều này không có nghĩa là tài liệu hiện vẫn còn khả dụng. Hãy tiếp tục xem tệp, hình ảnh và kỹ năng trong tin nhắn gốc.',
  ])
  assert.deepEqual(knowledgeRow('knowledge.ui.088').slice(2,7),['訊息資料 · ','Message resources · ','メッセージ資料・','메시지 자료 · ','Tài liệu tin nhắn · '])
  assert.deepEqual(knowledgeRow('knowledge.ui.089').slice(2,7),['歷史訊息','Historical message','履歴メッセージ','이전 메시지','Tin nhắn trước đó'])
  assert.deepEqual(knowledgeRow('knowledge.ui.090').slice(2,7),['第 ','Turn ','第','제 ','Lượt '])
  assert.deepEqual(knowledgeRow('knowledge.ui.091').slice(2,7),[' 輪',' of the conversation','ターン','회',' của cuộc trò chuyện'])
})

test('知识文档关键繁中词条不混用简体字',()=>{
  assert.equal(knowledgeRow('knowledge.ui.019')[2],'開啟頁面資訊與版本')
  assert.equal(knowledgeRow('knowledge.ui.045')[2],'正文已有更新；儲存時會產生新的可引用記錄，已傳送的會話和任務繼續使用原來鎖定的版本。')
  assert.equal(knowledgeRow('knowledge.ui.083')[2],'關閉資料引用記錄')
})

test('知识文档技术名词在各语言中保留产品写法',()=>{
  const localeColumns=[3,4,5,6,7,8,9,10]
  for(const column of localeColumns){
    assert.match(localized('knowledge.ui.023',column),/Teloa/)
    for(const key of ['knowledge.ui.024','knowledge.ui.036','knowledge.ui.037','knowledge.ui.051','knowledge.ui.067','knowledge.ui.072','knowledge.ui.073','knowledge.ui.074','knowledge.ui.075','knowledge.ui.076','knowledge.ui.077']){
      assert.match(localized(key,column),/Markdown/,`${key} column ${column} must preserve Markdown`)
    }
    assert.match(localized('knowledge.ui.077',column),/GitHub/)
  }
})

test('知识文档常用界面不含 Markdown 与编辑工具的明显机器误译',()=>{
  const frequentUi=KNOWLEDGE_DOCUMENT_MESSAGE_ROWS
    .filter(([key])=>/^knowledge\.ui\.0(?:0[1-9]|[1-7][0-9]|78)$/.test(key))
    .map(row=>row.slice(1).join('\n'))
    .join('\n')

  assert.doesNotMatch(frequentUi,/rebajas|démarque|redução/i)
  assert.doesNotMatch(frequentUi,/読書バージョン|大胆な|キャラクター/)
  assert.doesNotMatch(frequentUi,/만능인|빼는|용감한|암호|주문 목록|시사/)
  assert.doesNotMatch(frequentUi,/Đánh dấu|danh sách đặt hàng|mã số|nhân vật/)
  assert.doesNotMatch(frequentUi,/\u200b/)
})

test('知识文档英文标签使用一致的产品化表达与大小写',()=>{
  const expected:Record<string,string>={
    'knowledge.ui.013':'Knowledge document',
    'knowledge.ui.015':'Locked source version',
    'knowledge.ui.033':'Available for citation',
    'knowledge.ui.035':'Version history',
    'knowledge.ui.042':'Discard changes',
    'knowledge.ui.050':'Restore as new version',
    'knowledge.ui.054':'Resource type',
    'knowledge.ui.059':'Heading',
    'knowledge.ui.061':'Italic',
    'knowledge.ui.063':'Code',
    'knowledge.ui.065':'Bulleted list',
    'knowledge.ui.066':'Numbered list',
    'knowledge.ui.072':'Read-only Markdown',
    'knowledge.ui.077':'GitHub-flavored Markdown',
  }
  for(const [key,value] of Object.entries(expected))assert.equal(knowledgeRow(key)[3],value)
})
