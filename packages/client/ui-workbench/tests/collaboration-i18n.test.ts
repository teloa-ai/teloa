import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'
import {COLLABORATION_MESSAGE_ROWS} from '../src/client/i18n/locales/collaboration.ts'

const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const
const sourceFiles=['SavedCollaborationPage.tsx','CollaborationPage.tsx','TaskHandoffs.tsx'] as const

function messageRow(key:string):readonly string[]{
 const row=COLLABORATION_MESSAGE_ROWS.find(value=>value[0]===key)
 assert.ok(row,`missing ${key}`)
 return row
}

test('群协作与任务交接组件的固定中文全部通过协作词典呈现',async()=>{
 for(const name of sourceFiles){
  const source=await readFile(new URL(`../src/client/${name}`,import.meta.url),'utf8')
  assert.deepEqual(chineseUiLiterals(source,name,(value)=>[
   '人类成员','代拟','员工',
  ].includes(value)),[],name)
  assert.match(source,/useI18n\(\)/,name)
 }
})

test('协作词条按十语顺序完整提供，并保留动态正文边界',()=>{
 assert.equal(new Set(COLLABORATION_MESSAGE_ROWS.map(row=>row[0])).size,COLLABORATION_MESSAGE_ROWS.length,'duplicate collaboration message key')
 for(const row of COLLABORATION_MESSAGE_ROWS){
  assert.equal(row.length,locales.length+1,row[0])
  for(const [index,locale] of locales.entries())assert.ok(row[index+1]?.trim(),`${row[0]}: ${locale}`)
 }
 assert.deepEqual(messageRow('collaboration.directory.title'),[
  'collaboration.directory.title','群协作','群協作','Group collaboration','グループ協働','그룹 협업','Cộng tác nhóm','Colaboración en grupo','Collaboration de groupe','Gruppenzusammenarbeit','Colaboração em grupo',
 ])
 assert.deepEqual(messageRow('handoff.active.boundary'),[
  'handoff.active.boundary',"只更换后续负责人；不会开始任务、停止在途操作、转移原员工权限，或改写审批、成果与知识。","只更換後續負責人；不會開始任務、停止進行中的操作、轉移原員工權限，或改寫審批、成果與知識。","Only the next owner changes. This does not start the task, stop in-progress operations, transfer the previous employee’s permissions, or rewrite approvals, results, or knowledge.","後任の担当者だけを変更します。タスクの開始、進行中の操作の停止、元の従業員の権限移転、承認・成果・知識の書き換えは行いません。","다음 담당자만 변경합니다. 작업을 시작하거나 진행 중인 작업을 중지하거나 기존 직원의 권한을 이전하거나 승인, 결과 또는 지식을 다시 작성하지 않습니다.","Chỉ thay đổi người phụ trách tiếp theo. Thao tác này không bắt đầu nhiệm vụ, dừng hoạt động đang diễn ra, chuyển quyền của nhân viên cũ hoặc viết lại phê duyệt, kết quả hay kiến thức.","Solo cambia el siguiente responsable. Esto no inicia la tarea, detiene operaciones en curso, transfiere permisos del empleado anterior ni reescribe aprobaciones, resultados o conocimiento.","Seul le prochain responsable change. Cela ne démarre pas la tâche, n’arrête pas les opérations en cours, ne transfère pas les droits du employé précédent et ne réécrit ni approbations, ni résultats, ni connaissances.","Nur die nächste Zuständigkeit ändert sich. Dadurch wird die Aufgabe nicht gestartet, laufende Arbeit nicht gestoppt, keine Berechtigung des bisherigen Mitarbeiter übertragen und weder Genehmigungen noch Ergebnisse oder Wissen umgeschrieben.","Apenas muda o próximo responsável. Isto não inicia a tarefa, não interrompe operações em curso, não transfere permissões do funcionário anterior nem reescreve aprovações, resultados ou conhecimento.",
 ])
 const runtimeBoundary=messageRow('collaboration.agentGrant.runtimeBoundary')
 assert.match(runtimeBoundary[1]!,/不会启动任务.*不会让员工冒充本人.*授权时指定的资料版本.*当前群授权.*已结束的原生运行.*回传结果/)
 for(const fragment of ['does not start work','impersonate you','material versions set in the grant','current group authorization','completed native run','return to the group'])assert.ok(runtimeBoundary[3]!.includes(fragment),fragment)
 for(const forbidden of ['message.text','group.name','resource.body','task.title','member.name'])assert.ok(!COLLABORATION_MESSAGE_ROWS.some(row=>row[0]===forbidden),forbidden)
})

test('协作群弹层照原型定稿：创建与设置共用一套词条，不再出现演示与已保存字样',()=>{
 assert.equal(messageRow('collaboration.action.new')[1],'创建协作群')
 assert.equal(messageRow('collaboration.form.edit')[1],'成员与群设置')
 assert.equal(messageRow('collaboration.form.announcement')[1],'群公告')
 assert.equal(messageRow('collaboration.form.members')[1],'成员与职责')
 assert.equal(messageRow('collaboration.form.memberLimit')[1],'成员 · 至少 2 位，包含本人')
 assert.equal(messageRow('collaboration.form.memberBoundary')[1],'群与任务独立存在。分身作为独立成员显示，加入群不扩大资料、发言、审批或执行权限。')
 assert.equal(messageRow('collaboration.form.rule.history')[1],'新成员可以查看历史消息')
 assert.equal(messageRow('collaboration.form.rule.drafts')[1],'动作草案在本群可见')
 assert.equal(messageRow('collaboration.form.rule.mentionAll')[1],'允许 @全员')
 assert.equal(messageRow('collaboration.form.ruleBoundary')[1],'共享的是对象引用；每位成员以自己的授权读取资料与审批。')
 assert.equal(messageRow('collaboration.form.saveSettings')[1],'保存群设置')
 for(const removed of ['collaboration.form.newSaved','collaboration.form.createSaved','collaboration.form.createDemo','collaboration.form.saveDemo','collaboration.form.demoHint','collaboration.form.savedHint'])assert.equal(COLLABORATION_MESSAGE_ROWS.some(row=>row[0]===removed),false,removed)
 for(const row of COLLABORATION_MESSAGE_ROWS)for(const forbidden of ['演示群','已保存协作群'])assert.ok(!row[1]?.includes(forbidden),`${row[0]}: ${forbidden}`)
})

test('协作群页收掉界面演示模式：词条不再出现已保存与演示字样，成员不写人类',()=>{
 assert.equal(messageRow('collaboration.saved.title')[1],'协作群')
 assert.equal(messageRow('collaboration.directory.aria')[1],'协作群目录')
 assert.equal(messageRow('collaboration.directory.savedRecord')[1],'群记录')
 assert.equal(messageRow('collaboration.members.savedCount')[1],'{count} 位成员')
 assert.equal(messageRow('collaboration.state.saved')[1],'已登记')
 assert.equal(messageRow('collaboration.member.human')[1],'成员')
 for(const removed of ['collaboration.demo.label','collaboration.demo.boundary','collaboration.demo.progressBoundary','collaboration.action.examples','collaboration.examples.boundary','collaboration.action.backSaved'])assert.equal(COLLABORATION_MESSAGE_ROWS.some(row=>row[0]===removed),false,removed)
 for(const row of COLLABORATION_MESSAGE_ROWS)for(const forbidden of ['已保存','演示','人类','工作空间','单空间','实例','投影','尚未加载','内容待读取','项资源'])assert.ok(!row[1]?.includes(forbidden),`${row[0]}: ${forbidden}`)
})

test('协作群入口只渲染持久群页，不再分派界面演示分支',async()=>{
 const source=await readFile(new URL('../src/client/CollaborationPage.tsx',import.meta.url),'utf8')
 assert.match(source,/<SavedCollaborationPage key=/)
 assert.doesNotMatch(source,/PreviewCollaborationPage|savedGroups|persistence\?/)
})

test('群弹层成员区按个人版显示名呈现本人与分身',async()=>{
 const source=await readFile(new URL('../src/client/SavedCollaborationPage.tsx',import.meta.url),'utf8')
 assert.match(source,/<strong>\{profileName\}<\/strong><small>\{t\('collaboration\.message\.selfRole'\)\}<\/small>/)
 assert.match(source,/role\.kind==='twin'\?twinDisplayName\(profileName,t\):role\.name/)
 assert.match(source,/role\.kind==='twin'\?t\('collaboration\.member\.twin'\):role\.duty/)
 assert.equal(messageRow('collaboration.member.twin')[1],'分身')
})
