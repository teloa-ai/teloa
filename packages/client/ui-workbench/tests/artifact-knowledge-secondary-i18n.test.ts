import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS} from '../src/client/i18n/locales/artifact-knowledge-secondary.ts'

const files=[
  'ArtifactFiles.tsx',
  'NativeArtifactPicker.tsx',
  'TaskCompletion.tsx',
  'TaskKnowledge.tsx',
  'ProducedFileCards.tsx',
  'KnowledgeSaveReceiptCard.tsx',
  'knowledge-markdown.tsx',
  'ResourceRecovery.tsx',
] as const

for(const name of files)test(`${name} 的固定界面文案、日期与异常使用统一国际化`,async()=>{
  const source=await readFile(new URL(`../src/client/${name}`,import.meta.url),'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,name),[])
  assert.doesNotMatch(source,/toLocaleString\(\s*['"]zh-CN['"]|toLocaleString\(\s*\)/)
  assert.doesNotMatch(source,/instanceof Error\s*\?\s*[a-zA-Z_$][\w$]*\.message/)
})

test('成果与知识第二批词典接入十语言主词典',async()=>{
  const localeSource=await readFile(new URL('../src/client/i18n/locales/artifact-knowledge-secondary.ts',import.meta.url),'utf8').catch(()=> '')
  const coreSource=await readFile(new URL('../src/client/i18n/locales/core-pages.ts',import.meta.url),'utf8')
  assert.match(localeSource,/export const ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS/)
  assert.match(coreSource,/import \{ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS\}/)
  assert.match(coreSource,/\.\.\.ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS/)
  const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt']
  const keys=new Set<string>()
  for(const row of ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS){
    assert.equal(row.length,locales.length+1,row[0])
    assert.equal(keys.has(row[0]),false,`duplicate ${row[0]}`);keys.add(row[0])
    const placeholders=[...row[1].matchAll(/\{([^}]+)\}/g)].map(match=>match[1]).sort()
    for(let i=1;i<row.length;i++){
      const value=row[i]!
      assert.ok(value.trim(),`${row[0]} ${locales[i-1]}`)
      assert.deepEqual([...value.matchAll(/\{([^}]+)\}/g)].map(match=>match[1]).sort(),placeholders,`${row[0]} ${locales[i-1]}`)
    }
  }
})

const row=(key:string)=>{
  const value=ARTIFACT_KNOWLEDGE_SECONDARY_MESSAGE_ROWS.find(item=>item[0]===key)
  assert.ok(value,`missing ${key}`)
  return value
}

test('窄栏操作使用当地产品常见的短动词',()=>{
  assert.deepEqual(row('artifactFiles.discardEdit').slice(2,7),['取消','Cancel','キャンセル','취소','Hủy'])
  assert.deepEqual(row('nativeArtifact.refresh').slice(2,7),['重新整理','Refresh','更新','새로 고침','Làm mới'])
  assert.deepEqual(row('taskCompletion.submit').slice(2,7),['完成任務','Complete task','タスクを完了','작업 완료','Hoàn tất nhiệm vụ'])
  assert.deepEqual(row('producedFiles.open').slice(2,7),['在本機開啟','Open','開く','열기','Mở'])
})

test('成果与知识文案表达选择、任务和编辑动作，不使用逐字误译',()=>{
  assert.deepEqual(row('artifactFiles.candidates').slice(1),[
    '文件','檔案','Files','ファイル','파일','Tệp','Archivos','Fichiers','Dateien','Ficheiros',
  ])
  assert.deepEqual(row('artifactFiles.editTitle').slice(1),[
    '编辑 · {path}','編輯 · {path}','Edit · {path}','編集 · {path}','편집 · {path}',
    'Chỉnh sửa · {path}','Editar · {path}','Modifier · {path}','Bearbeiten · {path}','Editar · {path}',
  ])
  assert.deepEqual(row('nativeArtifact.empty').slice(1),[
    '这段历史记录中没有可选消息。','這段歷史記錄中沒有可選取的訊息。','No messages are available in this part of the history.',
    'この履歴には選択できるメッセージがありません。','이 기록에는 선택할 수 있는 메시지가 없습니다.',
    'Không có tin nhắn nào để chọn trong phần lịch sử này.','No hay mensajes disponibles en este tramo del historial.',
    'Aucun message sélectionnable dans cette partie de l’historique.','In diesem Verlaufsausschnitt sind keine Nachrichten auswählbar.',
    'Não há mensagens disponíveis neste trecho do histórico.',
  ])
  assert.deepEqual(row('taskKnowledge.empty').slice(1),[
    '尚未添加任务知识。','尚未新增任務知識。','No task knowledge added yet.','タスク知識はまだ追加されていません。',
    '작업 지식이 아직 추가되지 않았습니다.','Chưa thêm tri thức cho nhiệm vụ.','Aún no se ha añadido conocimiento a la tarea.',
    'Aucune connaissance n’a encore été ajoutée à la tâche.','Noch kein Aufgabenwissen hinzugefügt.',
    'Ainda não foi adicionado conhecimento à tarefa.',
  ])
  assert.deepEqual(row('markdown.empty').slice(1),[
    '还没有正文。','還沒有正文。','No content yet.','まだ本文がありません。','아직 본문이 없습니다.',
    'Chưa có nội dung.','Aún no hay contenido.','Aucun contenu pour le moment.','Noch kein Inhalt.','Ainda não há conteúdo.',
  ])
})

test('动态正文、路径、版本和哈希保持数据原文',async()=>{
  const sources=await Promise.all(files.map(name=>readFile(new URL(`../src/client/${name}`,import.meta.url),'utf8')))
  const joined=sources.join('\n')
  for(const value of ['file.path','message.text','record.note','material.title','receipt.contentHash','failure.reason'])assert.match(joined,new RegExp(value.replaceAll('.', '\\.')),value)
})
