import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

const read=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

test('新建会话先解析默认执行位置，选择器只用于例外和主动切换',async()=>{
  const source=await read('WorkbenchFrame.tsx')
  assert.match(source,/resolveConversationWorkspace\(/)
  // 群内直接回应一期 T14（2026-09-21）：新建会话多带一个可选 roleId（岗位会话/分身会话才有），
  // workspaceId 仍旧只由上面的 resolveConversationWorkspace 解析后传进来，这条钉子的原意不变。
  const file=ts.createSourceFile('WorkbenchFrame.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),options:ts.ObjectLiteralExpression[]=[]
  const compact=(node:ts.Node)=>node.getText(file).replace(/\s+/g,'')
  const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='options'&&node.initializer&&ts.isObjectLiteralExpression(node.initializer)&&node.initializer.properties.some(property=>ts.isSpreadAssignment(property)&&compact(property.expression)==='(workspaceId===undefined?{}:{workspaceId})'))options.push(node.initializer);ts.forEachChild(node,visit)}
  visit(file);assert.equal(options.length,1,'同一创建入口只构造一份已解析执行位置的 options')
  const spreads=options[0]!.properties.filter(ts.isSpreadAssignment).map(property=>compact(property.expression))
  assert.equal(spreads.filter(value=>value==='(workspaceId===undefined?{}:{workspaceId})').length,1,'缺省执行位置不写入；显式位置仍原样传递')
  assert.equal(spreads.filter(value=>value==="(intent.object?.kind==='role'?{roleId:intent.object.id}:{})").length,1,'只有原员工对象入口携带其 roleId，不代入其他对象')
  const declarations=new Map<string,ts.Expression>()
  let createWork:ts.FunctionDeclaration|undefined
  const findCreate=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='createWork')createWork=node;ts.forEachChild(node,findCreate)}
  findCreate(file);assert.ok(createWork)
  const collect=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer)declarations.set(node.name.text,node.initializer);ts.forEachChild(node,collect)}
  collect(createWork)
  const assistant=declarations.get('assistantResult'),conversation=declarations.get('conversation')
  assert.ok(assistant&&ts.isConditionalExpression(assistant)&&conversation&&ts.isConditionalExpression(conversation))
  assert.equal(compact(assistant.condition),'intent.assistant')
  assert.equal(compact(assistant.whenTrue),'awaitwork.createAssistantResult(options)')
  assert.equal(compact(assistant.whenFalse),'undefined')
  assert.equal(compact(conversation.condition),'assistantResult')
  assert.equal(compact(conversation.whenTrue),'assistantResult.conversation')
  assert.equal(compact(conversation.whenFalse),'awaitwork.create(options)')
  assert.match(source,/creationIntent&&workspaceSelection&&<CreateConversationDialog/)
  assert.match(source,/state\.view==='spaces'\?\{scope:state\.businessTarget\.scope\}:\{\}/)
  assert.match(source,/registryReady:nativeWorkspaces\.ready/)
  assert.match(source,/workspacePreferences\.write\(intent\.scope,workspaceId\)/)
})

test('跨多个业务范围的数字员工先选择会话语境，再复用范围默认执行位置',async()=>{
  const source=await read('WorkbenchFrame.tsx')
  const dialog=await read('ConversationScopeDialog.tsx')
  assert.match(source,/available\.length>1\)\{setRoleScopeIntent\(\{object:fresh,scopes:available,\.\.\.\(goal\?\{goal\}:\{\}\)\}\)/)
  assert.match(source,/const role=await readLatestConversationRole\(object\.id\)/)
  assert.match(source,/role\.scopes\.filter\(scope=>scopes\.includes\(scope\)\)/)
  assert.match(source,/requestRoleCreation\(object,role\.scopes\)/)
  assert.match(source,/roleScopes\?requestRoleCreation\(object,roleScopes\)/)
  assert.match(source,/<ConversationScopeDialog options=/)
  assert.match(source,/name=\{roleScopeIntent\.object\.title\}/)
  assert.match(source,/requestCreation\(\{object:intent\.object,scope,\.\.\.\(intent\.goal\?\{goal:intent\.goal\}:\{\}\)\}\)/)
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
  assert.match(frame,/createTask=\{\(\)=>requestTaskCreationConversation\(state\.view==='spaces'\?state\.businessTarget\.scope:'general'\)\}/)
  assert.match(frame,/<TaskPage\b[^>]*\bcreateConversation=\{requestTaskCreationConversation\}/)
  assert.match(frame,/createGroup=\{createDirectoryGroup\}/)
  assert.match(frame,/homeCreation==='task'&&<TaskForm persistent/)
  assert.match(source,/actions\.openPlans\(\)/)
  assert.match(source,/actions\.openDirectory\(\)/)
  assert.match(source,/\['ArrowDown','ArrowUp','Home','End'\]/)
  assert.match(source,/items\[next\]\?\.focus\(\)/)
  assert.doesNotMatch(source,/newWorkLocation[\s\S]{0,220}create\(\{chooseWorkspace:true\}\)/)
})

test('对话保持一级，任务自动化与需要你收进工作台；自动化仍进入原计划目录',async()=>{
  const [source,chrome,frame]=await Promise.all([read('WorkNavigation.tsx'),read('WorkbenchNavigationChrome.tsx'),read('WorkbenchFrame.tsx')])
  assert.match(source,/<WorkbenchNavigationItems view=\{view\} needCount=\{needCount\} attentionKnown=\{attentionKnown\}/)
  assert.match(source,/id==='plans'\?actions\.openPlans\(\{kind:'plans'\}\)/)
  assert.match(source,/id==='messages'\?actions\.openConversationDirectory\(\)/)
  assert.match(source,/actions\.navigate\(id\)/)
  assert.match(chrome,/className=\{clsx\(css\.navItem,active&&css\.active\)\}/)
  assert.match(chrome,/aria-current=\{active\?'page':undefined\} onClick=\{\(\)=>onSelect\(id\)\}/)
  // 1.0：待处理数量只在侧栏「工作台」与首页卡片出现，页签不重复角标。
  assert.match(chrome,/id==='home'&&needCount>0/)
  assert.doesNotMatch(chrome,/id==='attention'&&needCount>0/)
  assert.match(chrome,/\['messages','navigation\.v2\.conversations',MessageSquare\]/)
  assert.match(chrome,/workbenchHubNavigation=\[\['home',[^\n]*\['attention','navigation\.attention'[^\n]*\['tasks','navigation\.tasks'[^\n]*\['plans','navigation\.plans'/)
  assert.match(chrome,/id==='home'&&isWorkbenchHubView\(view\)/)
  assert.match(frame,/<WorkbenchHubNavigation [^\n]*onSelect=\{view=>view==='attention'\?actions\.openAttention\(\):view==='plans'\?actions\.openPlans\(\{kind:'plans'\}\):actions\.navigate\(view\)\}/)
})

test('需要你里的决策原地展开，打开任务动作再进入真实任务页',async()=>{
  const source=await read('WorkbenchFrame.tsx')
  assert.match(source,/const openAttentionTask=\(taskId:string\)=>actions\.openTask\(taskId\)/)
  assert.match(source,/openSecurityAction:\(taskId,actionId\)=>\{setSecurityFocus\([^}]*\}\)\);openAttentionTask\(taskId\)\},openTask:openAttentionTask,/)
})
