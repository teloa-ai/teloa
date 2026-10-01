import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const clientRoot=new URL('../src/client/',import.meta.url)

// 第二期把同事页改成全宽通讯录之后，它不再有两栏目录栏，也不再用筛选弹层（状态改成三档 aria-pressed 胶囊），
// 所以这两条守卫只留下仍是两栏目录的任务页与工作目录；同事页的新版面守卫在 team-page-layout.test.ts。
test('任务与统一会话目录复用紧凑目录样式，分别保留符合对象的筛选控件',async()=>{
  const sources=await Promise.all(['TaskPage.tsx','WorkDirectory.tsx'].map(name=>readFile(new URL(name,clientRoot),'utf8')))
  const [task,directory]=sources
  if(!task||!directory)throw Error('目录页面源码缺失。')
  for(const source of sources){
    assert.match(source,/import directoryCss from ['"]\.\/DirectoryPane\.module\.css['"]/)
    assert.match(source,/import \{DirectoryFilterPopover\} from ['"]\.\/DirectoryFilterPopover\.js['"]/)
    assert.match(source,/<DirectoryFilterPopover label=\{t\(/)
    assert.match(source,/<div className=\{directoryCss\.filterPanel\}>/)
  }
  assert.match(task,/<input type="radio"[^>]*aria-label=\{t\(/)
  assert.match(directory,/<fieldset><legend>\{t\('conversationDirectory\.state'\)\}<\/legend>/)
  assert.match(directory,/<input type="radio"[^>]*checked=\{!archived\}/)
})

test('需要你不再用横向页签常驻筛选，同事名单改成状态胶囊',async()=>{
  const [task,team]=await Promise.all([
    readFile(new URL('TaskPage.tsx',clientRoot),'utf8'),
    readFile(new URL('TeamPage.tsx',clientRoot),'utf8'),
  ])
  const taskDirectory=task.slice(task.indexOf('<aside data-teloa-pane="directory"'),task.indexOf('</aside>'))
  assert.doesNotMatch(taskDirectory,/attention&&<><nav className=\{css\.tabs\}/)
  assert.match(taskDirectory,/type="radio"/)
  assert.doesNotMatch(team,/<div className=\{css\.tabs\}>/)
  assert.doesNotMatch(team,/DirectoryFilterPopover/)
  assert.match(team,/statusPills\.map\(\(\[id, label\]\) => <button key=\{id\} type="button" aria-pressed=\{status === id\}/)
})

test('共享目录样式在 280px 内收窄并使用无卡片高密度列表行',async()=>{
  const css=await readFile(new URL('DirectoryPane.module.css',clientRoot),'utf8')
  assert.match(css,/\.pane\{[^}]*min-width:0[^}]*overflow-x:hidden/)
  assert.match(css,/\.row\{[^}]*border-radius:0[^}]*border-bottom:1px solid var\(--teloa-border\)[^}]*box-shadow:none/)
  assert.match(css,/\.rowBody\{[^}]*min-width:0/)
  assert.match(css,/\.summary\{[^}]*min-width:0/)
  assert.match(css,/\.filterPanel\{[^}]*max-height:[^;}]+[^}]*overflow-y:auto/)
  assert.match(css,/\.filterTrigger\[aria-expanded=true\]/)
  assert.match(css,/@media\(max-width:760px\)\{[^}]*\.pane/)
  assert.doesNotMatch(css,/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/)
})

test('会话和协作群组进入同一目录，低频成果与模板进入上下文菜单',async()=>{
  const source=await readFile(new URL('WorkbenchFrame.tsx',clientRoot),'utf8')
  assert.doesNotMatch(source,/<nav className=\{css\.messageTabs\}/)
  assert.match(source,/<WorkDirectory groups=\{conversationGroups\}/)
  assert.match(source,/openGroup=\{openSavedGroup\}/)
  assert.match(source,/createGroup=\{createDirectoryGroup\}/)
  const menu=source.slice(source.indexOf('<details ref={messageContextMenu} className={css.messageContext}>'))
  assert.match(menu,/<summary aria-label=/)
  assert.match(menu,/removeAttribute\('open'\);if\(current\)openArtifacts/)
  assert.match(menu,/removeAttribute\('open'\);saveConversation\(\)/)
  assert.match(menu,/shell\.artifacts/)
  assert.match(menu,/shell\.taskTemplate\.save/)
})
