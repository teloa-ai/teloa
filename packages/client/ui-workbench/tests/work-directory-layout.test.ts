import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {mount,nodes} from './market-component-harness.ts'

const root=new URL('../src/client/',import.meta.url)
const read=(name:string)=>readFile(new URL(name,root),'utf8')

test('目录头精简为新建，单聊与群共用一条列表，搜索与管理动作保持统一',()=>{
  const calls:string[]=[],noop=()=>()=>{},snapshot={status:'ready',rows:[]},managed={ready:true,baseline:true,workspaces:[{workspaceId:'ws',title:'Docs',path:'/docs',sessionIds:[]}],archived:[],pending:{}}
  function DirectoryFilterPopover(){}
  const page=mount('WorkDirectory.tsx',{'./DirectoryFilterPopover.js':{DirectoryFilterPopover},'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})},'./work-presentation.js':{presentConversations:()=>[],organizeConversations:()=>[]},'./search-phase.js':{searchPhase:()=> 'idle'},'./conversation-search.js':{searchPhase:()=> 'idle'},'./saved-collaboration-state.js':{visibleSavedGroups:()=>[]}})
  const props={work:{subscribe:noop,getDirectorySnapshot:()=>snapshot,refreshDirectory:()=>calls.push('refresh-conversations')},management:{subscribe:noop,getSnapshot:()=>managed},search:{subscribe:noop,getSnapshot:()=>({items:[]})},current:undefined,useSessions:(select:any)=>select({byId:{},ids:[]}),onOpened:()=>{},focusRequest:0,onClose:()=>calls.push('close'),groups:{subscribe:noop,getSnapshot:()=>({status:'ready',items:[]}),refresh:()=>calls.push('refresh-groups')},selectedGroup:undefined,openGroup:()=>{},createGroup:()=>calls.push('new-group'),onCreateConversation:()=>calls.push('new-conversation'),creating:false}
  let tree=page.render('WorkDirectory',props)
  const header=nodes(tree).find(node=>node.type==='header')!
  assert.equal(nodes(header).filter(node=>node.type==='summary').length,1)
  assert.equal(nodes(header).some(node=>node.children.includes('workDirectory.refresh')),false)
  assert.equal(nodes(header).some(node=>node.children.includes('workDirectory.close')),false)
  nodes(header).find(node=>node.type==='button'&&node.children.includes('navigation.newConversation'))!.props.onClick()
  nodes(header).find(node=>node.type==='button'&&node.children.includes('collaboration.action.new'))!.props.onClick()
  const searchRow=nodes(tree).find(node=>node.props.className==='searchRow')!
  assert.ok(nodes(searchRow).some(node=>node.type==='input'&&node.props['aria-label']==='workDirectory.search.aria'))
  const filter=nodes(searchRow).find(node=>node.type===DirectoryFilterPopover)!
  assert.equal(filter.props.label,'conversationDirectory.filters')
  nodes(filter).find(node=>node.type==='button'&&node.children.includes('workDirectory.refresh'))!.props.onClick()
  nodes(filter).find(node=>node.type==='button'&&node.children.includes('workDirectory.close'))!.props.onClick()
  assert.deepEqual(calls,['new-conversation','new-group','refresh-conversations','refresh-groups','close'])
  nodes(filter).filter(node=>node.type==='input'&&node.props.type==='radio')[1]!.props.onChange()
  nodes(filter).find(node=>node.type==='select'&&node.props['aria-label']==='workDirectory.workspace.filterAria')!.props.onChange({target:{value:'workspace:ws'}})
  tree=page.render('WorkDirectory',props)
  assert.equal(nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='workDirectory.order.aria')!.props.disabled,false)
  assert.ok(nodes(tree).some(node=>node.props.className==='activeFilters'))
  assert.ok(nodes(tree).some(node=>node.type==='div'&&node.props['aria-label']==='navigation.v2.conversations'))
  assert.equal(nodes(tree).some(node=>node.type==='section'&&['conversationDirectory.direct','conversationDirectory.groups'].includes(node.props['aria-label'])),false)
  tree=page.render('WorkDirectory',{...props,creating:true})
  assert.equal(nodes(tree).find(node=>node.type==='button'&&node.children.includes('navigation.newConversation'))!.props.disabled,true)
})

test('同一目录中的群和一对一仍打开各自真实通道，群详情复用目录并保留授权面',async()=>{
 const [directory,frame,group,collaboration]=await Promise.all([read('WorkDirectory.tsx'),read('WorkbenchFrame.tsx'),read('SavedCollaborationPage.tsx'),read('CollaborationPage.tsx')])
 assert.doesNotMatch(directory,/className=\{css\.section\} aria-label=\{t\('conversationDirectory\.(direct|groups)'\)\}/)
 assert.match(directory,/unifiedRows\.map\(entry=>/)
 assert.match(directory,/await work\.openConversation\(row\)/)
 assert.match(directory,/onClick=\{\(\)=>openGroup\(group\.id\)\}/)
 assert.match(frame,/const openSavedGroup=.*?setGroupCreateRequest\(0\);actions\.openGroupTopic\(id,''\)/)
 assert.match(frame,/onOpened=\{\(\)=>\{actions\.openMessages\('native'\)/)
 assert.doesNotMatch(frame,/shell\.messageType\.(ai|group)/)
 assert.match(group,/!conversationDirectory&&<aside className=\{css\.directory\}/)
 assert.match(group,/api\.changeAgentGrant\(group\.id,role\.id,group\.version,role\.version,'save',selectedResources,canPost,canAutoRun\)/)
 assert.match(group,/void reloadSelected\(\);void refreshDirectory\(\)/)
 assert.match(group,/scheduleGroupMessageRefresh\(\(\)=>reloadSelected\(selected\)\)/)
 assert.match(collaboration,/key=\{persistence\.directory\?props\.target\?\.groupId:undefined\}/)
})

test('对话目录根态只提示选择，点具体条目后才切换到原生单聊或持久群',async()=>{
 const [navigation,frame,store]=await Promise.all([read('WorkNavigation.tsx'),read('WorkbenchFrame.tsx'),read('store.ts')])
 assert.match(navigation,/id==='messages'\?actions\.openConversationDirectory\(\)/)
 assert.match(store,/openConversationDirectory\(state\)\{showWorkbenchView\(state,'messages'\);state\.messageMode='directory';state\.directoryOpen=true/)
 assert.match(frame,/const conversationDirectoryVisible=state\.view==='messages'&&state\.messageMode==='directory'/)
 assert.match(frame,/conversationDirectoryVisible&&<section className=\{css\.conversationLanding\}/)
 assert.match(frame,/onOpened=\{\(\)=>\{actions\.openMessages\('native'\)/)
 assert.match(frame,/const openSavedGroup=.*?actions\.openGroupTopic\(id,''\)/)
})

test('会话列表把标题和时间放在首行，不为每条记录重复类型标签',async()=>{
  const source=await read('WorkDirectory.tsx')
  assert.match(source,/<span className=\{css\.rowTop\}><strong>\{title\}<\/strong><time/)
  const rows=source.slice(source.indexOf('<div className={clsx(css.rows'),source.indexOf('</div>',source.indexOf('<div className={clsx(css.rows'))+6)
  assert.doesNotMatch(rows,/t\('workDirectory\.conversation'\)/)
})

test('窄目录不会横向溢出，列表行紧凑且次要操作按需显现',async()=>{
  const [directory,shared,navigation]=await Promise.all([
    read('WorkDirectory.module.css'),
    read('DirectoryPane.module.css'),
    read('WorkbenchFrame.module.css'),
  ])
  assert.match(directory,/\.mailRow\{[^}]*min-width:0[^}]*width:100%/)
  assert.match(directory,/\.mailBody strong\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/)
  assert.match(directory,/\.rows \.more\{[^}]*opacity:0/)
  assert.match(directory,/\.row:hover \.more,.row:focus-within \.more\{opacity:1/)
  assert.match(shared,/\.row\{[^}]*min-width:0[^}]*border-radius:0/)
  assert.match(directory,/\.directory \.row\{[^}]*padding:8px 7px!important/)
  assert.match(navigation,/\.navigation\{[^}]*min-height:0[^}]*overflow:hidden/)
  assert.match(navigation,/\.navScroll\{[^}]*flex:1 1 auto[^}]*min-height:0[^}]*overflow-y:auto/)
  assert.match(navigation,/\.navFooter\{[^}]*flex:none/)
  assert.match(navigation,/\.newWorkMenu\{[^}]*width:100%[^}]*max-width:calc\(100vw - 24px\)/)
  assert.match(navigation,/\.newWork>span\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/)
  assert.doesNotMatch(directory+shared+navigation,/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/)
})

test('390px 会话上下文允许长对象操作换行，触屏目录操作保持 44px 命中区',async()=>{
  const [directory,frame]=await Promise.all([read('WorkDirectory.module.css'),read('WorkbenchFrame.module.css')])
  assert.match(frame,/\.objectActions\{[^}]*min-width:0[^}]*max-width:100%[^}]*flex-wrap:wrap/)
  assert.match(frame,/@media\(max-width:740px\)\{[\s\S]*?\.objectActions\{width:100%;margin-left:0\}/)
  assert.match(frame,/\.objectActions button\{min-height:44px;white-space:normal;overflow-wrap:anywhere\}/)
  assert.match(directory,/@media\(max-width:740px\)\{[\s\S]*?\.rows \.more,\.orderButtons button\{width:44px;min-height:44px\}/)
})

test('分身是默认身份，词典不再保留“招聘分身”与“人类分身”旧口径',async()=>{
  const [edition,team,core,market]=await Promise.all([
    read('i18n/locales/edition.ts'),read('i18n/locales/team-details.ts'),read('i18n/locales/core-pages.ts'),read('i18n/locales/market-industry.ts'),
  ])
  assert.doesNotMatch(edition,/navigation\.twinMissing/)
  assert.doesNotMatch(team+core+market,/人类分身|人類分身|Human twin|人の分身|사람 분신|Bản sao con người|Doble humano|Double humain|Menschlicher Zwilling|Duplo humano/)
})

test('对话主区保留 DSH 原生能力，并由 Teloa 统一标题层级和视觉外壳',async()=>{
  const [frame,css]=await Promise.all([read('WorkbenchFrame.tsx'),read('WorkbenchFrame.module.css')])
  assert.match(frame,/className=\{clsx\(css\.nativeConversation,[^\n]+renderSlot\('teloa\.conversation'/)
  const shell=await read('HomeNativeConversation.tsx')
  assert.match(frame,/content:renderSlot\('main',\{\}, \{entryKey:'conversation'\}\)/)
  assert.match(css,/\.nativeConversation :global\(\[data-slot="conversation\.session\.header"\]\)>header\{[^}]*min-height:76px[^}]*background:var\(--teloa-background\)[^}]*border-bottom:1px solid var\(--teloa-border\)/)
  assert.match(css,/\.nativeConversation :global\(\[data-slot="conversation\.session\.header"\]\) nav button\{[^}]*font-size:var\(--teloa-font-section\)[^}]*font-weight:var\(--teloa-weight-heading\)/)
  assert.match(css,/\.nativeConversation :global\(\[role="tablist"\]\)\{padding-inline:24px\}/)
})
