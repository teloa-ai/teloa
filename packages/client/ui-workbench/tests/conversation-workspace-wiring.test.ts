import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const read=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

test('新建会话先解析默认执行位置，选择器只用于例外和主动切换',async()=>{
  const source=await read('WorkbenchFrame.tsx')
  assert.match(source,/resolveConversationWorkspace\(/)
  // 群内直接回应一期 T14（2026-09-21）：新建会话多带一个可选 roleId（岗位会话/分身会话才有），
  // workspaceId 仍旧只由上面的 resolveConversationWorkspace 解析后传进来，这条钉子的原意不变。
  assert.match(source,/work\.create\(\{\s*\.\.\.\(workspaceId===undefined\?\{\}:\{workspaceId\}\),\.\.\.\(intent\.object\?\.kind==='role'\?\{roleId:intent\.object\.id\}:\{\}\)/)
  assert.match(source,/creationIntent&&workspaceSelection&&<CreateConversationDialog/)
  assert.match(source,/state\.view==='spaces'\?\{scope:state\.businessTarget\.scope\}:\{\}/)
  assert.match(source,/registryReady:nativeWorkspaces\.ready/)
  assert.match(source,/workspacePreferences\.write\(intent\.scope,workspaceId\)/)
})

test('跨多个业务范围的数字员工先选择会话语境，再复用范围默认执行位置',async()=>{
  const source=await read('WorkbenchFrame.tsx')
  const dialog=await read('ConversationScopeDialog.tsx')
  assert.match(source,/available\.length>1\)\{setRoleScopeIntent\(\{object,scopes:available\}\)/)
  assert.match(source,/requestRoleCreation\(object,role\.scopes\)/)
  assert.match(source,/roleScopes\?requestRoleCreation\(object,roleScopes\)/)
  assert.match(source,/<ConversationScopeDialog options=/)
  assert.match(source,/name=\{roleScopeIntent\.object\.title\}/)
  assert.match(source,/requestCreation\(\{object:intent\.object,scope\}\)/)
  assert.match(dialog,/conversationDialog\.scopeDescription',\{name\}\)/)
  assert.match(dialog,/useState<CollaborationScope>\(options\[0\]\?\.id\?\?''\)/)
  assert.doesNotMatch(dialog,/conversationDialog\.selectScope/)
})

test('主导航用单个紧凑新建按钮展开会话、工作与执行位置菜单',async()=>{
  const source=await read('WorkNavigation.tsx')
  assert.match(source,/onClick=\{\(\)=>fromNewWorkMenu\(\(\)=>create\(\)\)\}/)
  assert.match(source,/ref=\{newWorkTrigger\} type="button" className=\{css\.newWork\} aria-label=\{t\('navigation\.new'\)\}/)
  assert.doesNotMatch(source,/newWorkLocation|ChevronRight/)
  assert.doesNotMatch(source,/t\(['"]navigation\.startWork['"]\)/)
  assert.match(source,/aria-haspopup="menu"/)
  assert.match(source,/role="menu"/)
  assert.match(source,/navigation\.newConversation/)
  assert.match(source,/navigation\.newTask/)
  assert.match(source,/navigation\.newContinuous/)
  assert.match(source,/conversationDialog\.otherLocation/)
  assert.match(source,/create\(\{chooseWorkspace:true\}\)/)
  assert.match(source,/conversationDialog\.manage/)
  assert.match(source,/fromNewWorkMenu\(createTask\)/)
  assert.match(source,/fromNewWorkMenu\(createGroup\)/)
  const frame=await read('WorkbenchFrame.tsx')
  assert.match(frame,/createTask=\{\(\)=>createFromHome\('task'\)\}/)
  assert.match(frame,/createGroup=\{createDirectoryGroup\}/)
  assert.match(frame,/homeCreation==='task'&&<TaskForm persistent/)
  assert.match(source,/actions\.openPlans\(\)/)
  assert.match(source,/actions\.openDirectory\(\)/)
  assert.match(source,/\['ArrowDown','ArrowUp','Home','End'\]/)
  assert.match(source,/items\[next\]\?\.focus\(\)/)
  assert.doesNotMatch(source,/newWorkLocation[\s\S]{0,220}create\(\{chooseWorkspace:true\}\)/)
})

test('对话、任务与自动化并列，自动化直接进入计划目录',async()=>{
  const [source,chrome]=await Promise.all([read('WorkNavigation.tsx'),read('WorkbenchNavigationChrome.tsx')])
  assert.match(source,/<WorkbenchNavigationItems view=\{view\} needCount=\{needCount\} attentionKnown=\{attentionKnown\}/)
  assert.match(source,/id==='plans'\?actions\.openPlans\(\{kind:'plans'\}\)/)
  assert.match(source,/id==='messages'\?actions\.openConversationDirectory\(\)/)
  assert.match(source,/actions\.navigate\(id\)/)
  assert.match(chrome,/className=\{clsx\(css\.navItem,active&&css\.active\)\}/)
  assert.match(chrome,/aria-current=\{active\?'page':undefined\} onClick=\{\(\)=>onSelect\(id\)\}/)
  assert.match(chrome,/id==='attention'&&needCount>0/)
  assert.match(chrome,/\['messages','navigation\.v2\.conversations',MessageSquare\]/)
  assert.match(chrome,/\['tasks','navigation\.tasks',CheckSquare\]/)
  assert.match(chrome,/\['plans','navigation\.plans',CalendarClock\]/)
  assert.match(chrome,/const active=view===id\|\|\(id==='capabilities'&&view==='market'\);/)
  assert.doesNotMatch(chrome,/\(view==='tasks'\|\|view==='plans'\)&&id==='home'/)
})

test('需要你里的决策原地展开，打开任务动作再进入真实任务页',async()=>{
  const source=await read('WorkbenchFrame.tsx')
  assert.match(source,/const openAttentionTask=\(taskId:string\)=>actions\.openTask\(taskId\)/)
  assert.match(source,/openSecurityAction:\(taskId,actionId\)=>\{setSecurityFocus\([^}]*\}\)\);openAttentionTask\(taskId\)\},openTask:openAttentionTask,/)
})
