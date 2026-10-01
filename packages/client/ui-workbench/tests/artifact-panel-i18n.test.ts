import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {ARTIFACT_PANEL_MESSAGE_ROWS} from '../src/client/i18n/locales/artifact-panel.ts'

const url=new URL('../src/client/ArtifactPanel.tsx',import.meta.url)

test('工作成果面板的固定文案全部来自词典',async()=>{
  const source=await readFile(url,'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source,'artifact-panel-i18n.test.ts'),[])
})


test('成果面板词典按十语顺序完整且保留动态正文',async()=>{
  const source=await readFile(url,'utf8'),locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt']
  for(const row of ARTIFACT_PANEL_MESSAGE_ROWS){assert.equal(row.length,locales.length+1,row[0]);for(let i=1;i<row.length;i++)assert.ok(row[i]!.trim(),row[0]+' '+locales[i-1])}
  for(const value of ['version.title','version.note','item.title','item.text','draft.body','draft.note','draft.feedback'])assert.match(source,new RegExp(value.replaceAll('.', '\\.')),value)
})

const artifactRow=(key:string)=>{
  const row=ARTIFACT_PANEL_MESSAGE_ROWS.find(item=>item[0]===key)
  assert.ok(row,`missing ${key}`)
  return row
}

test('成果面板在各语言中保留成果、锁定依据与来源语义',()=>{
  assert.deepEqual(artifactRow('artifact.panel.text.009').slice(2,7),['關閉工作成果面板','Close work output panel','作業成果パネルを閉じる','작업 결과물 패널 닫기','Đóng bảng kết quả công việc'])
  assert.deepEqual(artifactRow('artifact.panel.text.011').slice(2,7),['成果目錄','Work output directory','作業成果一覧','작업 결과물 디렉터리','Danh mục kết quả công việc'])
  assert.deepEqual(artifactRow('artifact.panel.text.055').slice(2,7),['查看鎖定的依據','Review locked evidence','固定された根拠を確認','고정 근거 확인','Xem căn cứ cố định'])
  assert.deepEqual(artifactRow('artifact.panel.text.118').slice(2,7),['所選成果版本不存在，請從左側重新選擇。','The selected work output version does not exist. Select it again from the left.','選択した作業成果のバージョンは存在しません。左側から選び直してください。','선택한 작업 결과물 버전이 없습니다. 왼쪽에서 다시 선택하세요.','Phiên bản kết quả công việc đã chọn không tồn tại. Hãy chọn lại ở bên trái.'])
  assert.deepEqual(artifactRow('artifact.panel.text.119').slice(2,7),['來源已變更，未儲存內容保留。核對目前來源後才能繼續。','The source has changed, and unsaved content has been retained. Review the current source before continuing.','ソースが変更されました。未保存の内容は保持されています。続行する前に現在のソースを確認してください。','소스가 변경되었으며 저장하지 않은 콘텐츠는 유지되었습니다. 계속하기 전에 현재 소스를 확인하세요.','Nguồn đã thay đổi và nội dung chưa lưu được giữ lại. Hãy kiểm tra nguồn hiện tại trước khi tiếp tục.'])
})

test('成果面板关键繁中词条不混用简体字',()=>{
  assert.equal(artifactRow('artifact.panel.text.008')[2],'本人 · 目前頁面示範，未持久化或共享')
  assert.equal(artifactRow('artifact.panel.text.052')[2],'共享邊界')
  assert.equal(artifactRow('artifact.panel.text.053')[2],'本人會話來源；僅保留明確選取的內容，未共享歷史。')
  assert.equal(artifactRow('artifact.panel.text.056')[2],'未附額外依據。')
  assert.equal(artifactRow('artifact.panel.text.099')[2],'儲存新版本（示範）')
  assert.equal(artifactRow('artifact.panel.text.100')[2],'放棄此段未儲存修改，保留回饋')
  assert.equal(artifactRow('artifact.panel.text.101')[2],'這是歷史版本。選擇最新版後再修改，舊版回饋繼續保留。')
})

test('已保存成果明确说明更多操作的当前能力边界',()=>{
  assert.deepEqual(artifactRow('artifact.panel.text.121').slice(1,4),[
    '此成果已保存到本机。当前可通过反馈或修订继续完善；关联、送审和创建跟进任务尚未接入。',
    '此成果已儲存到本機。目前可透過回饋或修訂繼續完善；關聯、送審和建立跟進任務尚未接入。',
    'This work result is saved to this machine. Continue improving it with feedback or revisions; linking, review submission, and follow-up task creation are not available yet.',
  ])
})

test('终态已保存成果明确说明修订与跟进均不可用',()=>{
  assert.deepEqual(artifactRow('artifact.panel.text.122').slice(1,4),[
    '来源任务已结束。仍可查看、添加反馈和导出 Markdown；修订、关联、送审和创建跟进任务当前不可用。',
    '來源任務已結束。仍可查看、加入回饋和匯出 Markdown；修訂、關聯、送審和建立跟進任務目前不可用。',
    'The source task has ended. You can still view, add feedback, and export Markdown; revisions, linking, review submission, and follow-up task creation are not available.',
  ])
})
