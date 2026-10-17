import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes,type MarketNode} from './market-component-harness.ts'
import type {Conversation} from '@teloa/contract'
import * as dialogueOrganization from '../src/client/dialogue-organization.ts'
import * as dialogueCopy from '../src/client/dialogue-copy.ts'
import * as presentation from '../src/client/work-presentation.ts'
import * as roleIdentity from '../src/client/session-role-identity.ts'

// D-141 读取稳定性：目录员工身份只在「目录代次 / 员工表」变化时重读；筛选、管理就绪翻转、
// 加载中与失败快照这些与目录内容无关的状态更新不得对全部会话再次发起 object-conversations/session。
// 夹具自带按依赖比较的 effect 运行时，模拟真实 React 的 useEffect 触发边界。

type Effect={fn:()=>unknown;deps:unknown[]|undefined;cleanup?:unknown}
function reactRuntime(){
 const states:unknown[]=[];let cursor=0,previous:Effect[]=[],pending:Effect[]=[]
 const react={
  useState:(initial:unknown)=>{const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?(initial as()=>unknown)():initial;return [states[i],(next:unknown)=>{states[i]=typeof next==='function'?(next as(v:unknown)=>unknown)(states[i]):next}]},
  useRef:(value:unknown)=>{const i=cursor++;return (states[i]??=({current:value})) as {current:unknown}},
  useId:()=>'fixture-id',
  useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),
  useMemo:(factory:()=>unknown)=>factory(),
  useCallback:(fn:unknown)=>fn,
  useEffect:(fn:()=>unknown,deps?:unknown[])=>{pending.push({fn,deps})},
 }
 const begin=()=>{cursor=0;pending=[]}
 const commit=()=>{
  pending.forEach((effect,index)=>{
   const before=previous[index]
   const changed=!before||!effect.deps||!before.deps||effect.deps.length!==before.deps.length||effect.deps.some((dep,j)=>!Object.is(dep,before.deps![j]))
   if(!changed){effect.cleanup=before.cleanup;return}
   if(typeof before?.cleanup==='function')(before.cleanup as()=>void)()
   effect.cleanup=effect.fn()
  })
  previous=pending
 }
 const dispose=()=>{for(const effect of previous)if(typeof effect.cleanup==='function')(effect.cleanup as()=>void)();previous=[]}
 return {react,begin,commit,dispose}
}

function conversation(sessionId:string):Conversation{return {id:'work-'+sessionId,ownerId:'owner',title:'Chat '+sessionId,scopeIds:['general'],version:1,status:'ready',sessionId,requestedSessionId:sessionId,createdAt:'2026-10-07T00:00:00Z'}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
type Link={kind:'role';sessionId:string;objectId:string;active:true}

test('读取端口更换时重新核验，不沿用前一端口的身份结果',async t=>{
 const f=fixture(t);f.render();await settle();assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Alice')
 const calls:string[]=[],pending:{id:string;resolve:(rows:Link[])=>void}[]=[]
 f.replaceApi({bySession:id=>{calls.push(id);return new Promise<Link[]>(resolve=>pending.push({id,resolve}))}})
 f.render();await settle();assert.deepEqual(calls,['A','B'])
 assert.equal(f.titleOf('A'),'Chat A','新读取端口未完成核验前不显示旧身份')
 for(const read of pending)read.resolve([])
 await settle();assert.equal(f.titleOf('A'),'Chat A')
 assert.deepEqual(calls,['A','B'],'同一端口的无关重渲染不重复读取')
})

test('空白和仅群分类下不可见的单聊不读取身份，切回可见分类只补读本代尚未核验的条目',async t=>{
 const f=fixture(t)
 f.state.directory.rows.push(conversation('empty'))
 f.state.native={byId:{empty:{id:'empty',title:'空白工作',running:false,blank:true,updatedAt:1}},ids:['empty']}
 f.render();await settle();assert.deepEqual(f.calls,['A','B'],'原生空白会话不在可展示目录，不作身份读取')
 const select=(key:'session'|'group')=>{f.control(node=>node.type==='button'&&node.children.includes(dialogueCopy.dialogueCopy('en',key))).props.onClick();f.render()}
 select('group')
 f.state.directory={...f.state.directory,rows:[...f.state.directory.rows,conversation('C')]}
 f.render();await settle();assert.deepEqual(f.calls,['A','B'],'只显示群时，刷新也不读取隐藏单聊')
 select('session');await settle();assert.deepEqual(f.calls,['A','B','A','B','C'],'当前代次可见条目仍按真实目录重新核验')
 select('group');select('session');await settle();assert.deepEqual(f.calls,['A','B','A','B','C'],'分类回切复用同一代次的身份读取')
})

function fixture(t:TestContext){
 const runtime=reactRuntime(),noop=()=>()=>{}
 t.after(()=>runtime.dispose())
 let store:dialogueOrganization.DialogueOrganization|undefined
 const organization={'./dialogue-organization.js':{...dialogueOrganization,browserDialogueOrganization:()=>{const data=new Map<string,string>();store=dialogueOrganization.createDialogueOrganization({getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value)}});return store}},'./dialogue-copy.js':dialogueCopy}
 const page=mount('WorkDirectory.tsx',{react:runtime.react,...organization,'./business-scope-context.js':{useBusinessScopes:()=>({general:'General'})},'./work-presentation.js':presentation,'./session-role-identity.js':roleIdentity,'./conversation-search.js':{searchPhase:()=> 'idle'},'./saved-collaboration-state.js':{visibleSavedGroups:()=>[]},'./i18n/provider.js':{useI18n:()=>({t:(key:string,params?:{name?:string})=>params?.name?key+':'+params.name:key,locale:'en',dateTime:()=> '10/07'})},'./i18n/errors.js':{localizeWorkError:(_locale:string,error:unknown)=>error instanceof Error?error.message:String(error)},'./ConversationActions.js':{ConversationActions:()=>null,ConversationActionMenu:()=>null}})
 const calls:string[]=[],holds:{sessionId:string;resolve:(links:Link[])=>void}[]=[]
 let holding=false
 const linksFor=(objectId:string|undefined)=>(sessionId:string):Link[]=>objectId&&sessionId==='A'?[{kind:'role',sessionId,objectId,active:true}]:[]
 let objectApi={bySession:(sessionId:string)=>{calls.push(sessionId);if(!holding)return Promise.resolve(linksFor('alice')(sessionId));return new Promise<Link[]>(resolve=>holds.push({sessionId,resolve}))}}
 const state={directory:{status:'ready' as 'ready'|'loading'|'failed',rows:[conversation('A'),conversation('B')],error:undefined as unknown},managed:{ready:true,baseline:true,workspaces:[],archived:[] as string[],pending:{}},native:{byId:{} as Record<string,unknown>,ids:[] as string[]},roles:[{id:'alice',name:'Alice',kind:'employee',avatarKey:'squirrel-general'}] as {id:string;name:string;kind:string;avatarKey:string}[],current:undefined as string|undefined,selectedGroup:undefined as string|undefined}
 const props=()=>({work:{subscribe:noop,getDirectorySnapshot:()=>state.directory,refreshDirectory:async()=>{},openConversation:async()=> 'opened'},management:{subscribe:noop,getSnapshot:()=>state.managed},search:{subscribe:noop,getSnapshot:()=>({items:[],hasMore:false}),clear:()=>{},run:async()=>{}},groups:{subscribe:noop,getSnapshot:()=>({status:'ready',items:[]}),refresh:async()=>{}},objectApi,roles:state.roles,useSessions:(select:(value:unknown)=>unknown)=>select(state.native),current:state.current,onOpened:()=>{},focusRequest:0,onClose:()=>{},selectedGroup:state.selectedGroup,openGroup:()=>{},createGroup:()=>{}})
 let tree:MarketNode
 const render=()=>{runtime.begin();tree=page.render('WorkDirectory',props());runtime.commit();return tree}
 const rowOf=(sessionId:string)=>nodes(render()).find(node=>node.props['data-session-id']===sessionId)
 /** 原行可能在会话或员工分类：只为取标题临时切换，取完恢复原分类。 */
 const titleOf=(sessionId:string)=>{let row=rowOf(sessionId);const before=store!.getSnapshot().type
  for(const type of ['session','employee','group'] as const){if(row)break;store!.selectType(type);row=rowOf(sessionId)}
  if(store!.getSnapshot().type!==before){store!.selectType(before);render()}
  assert.ok(row,'目录行 '+sessionId);return String(nodes(row).find(node=>node.type==='strong')!.children[0])}
 const visible=()=>nodes(render()).flatMap(node=>typeof node.props['data-session-id']==='string'?[node.props['data-session-id'] as string]:[])
 const control=(predicate:(node:MarketNode)=>boolean)=>{const node=nodes(tree).find(predicate);assert.ok(node,'控件缺失');return node}
 return {state,calls,render,titleOf,visible,type:()=>store!.getSnapshot().type,control,replaceApi:(next:typeof objectApi)=>{objectApi=next},
  hold:(value:boolean)=>{holding=value},
  pendingReads:()=>holds.length,
  /** 放行最早（first）或最新（last）挂起的 count 个读取，A 会话应答指定员工。 */
  release:(where:'first'|'last',count:number,objectId:string)=>{const batch=where==='first'?holds.splice(0,count):holds.splice(holds.length-count,count);assert.equal(batch.length,count,'挂起读取数量');for(const {sessionId,resolve} of batch)resolve(linksFor(objectId)(sessionId))},
 }
}

test('同一目录代次下，筛选、管理就绪翻转、加载中与失败快照都不重读全部会话身份；空员工表不发请求',async t=>{
 const f=fixture(t)
 f.render();await settle()
 assert.deepEqual(f.calls,['A','B'],'首次就绪目录按会话各读一次')
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Alice')
 assert.equal(f.titleOf('B'),'Chat B')

 // 搜索、归档筛选只改变可见行，不改变目录内容：不重读。
 f.control(node=>node.type==='input'&&node.props['aria-label']==='workDirectory.search.aria').props.onChange({target:{value:'A'}})
 f.render();await settle()
 assert.deepEqual(f.calls,['A','B'],'输入搜索词不重读')
 f.control(node=>node.type==='input'&&node.props['aria-label']==='workDirectory.search.aria').props.onChange({target:{value:''}})
 f.render();await settle()
 const radios=nodes(f.render()).filter(node=>node.type==='input'&&node.props.type==='radio')
 radios[1]!.props.onChange();f.render();await settle()
 radios[0]!.props.onChange();f.render();await settle()
 assert.deepEqual(f.calls,['A','B'],'切换归档筛选不重读')
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Alice','筛选来回后身份仍在')

 // 原生会话摘要刷新、管理层就绪翻转：目录内容未变，不重读。
 f.state.native={byId:{A:{id:'A',title:'Chat A',running:true,blank:false,updatedAt:1}},ids:['A']}
 f.render();await settle()
 f.state.managed={...f.state.managed,ready:false};f.render();await settle()
 f.state.managed={...f.state.managed,ready:true};f.render();await settle()
 assert.deepEqual(f.calls,['A','B'],'管理层就绪翻转不重读')

 // 加载中与失败快照沿用同一批行：不重读，也不把已核实身份摘掉。
 const rows=f.state.directory.rows
 f.state.directory={status:'loading',rows,error:undefined};f.render();await settle()
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Alice','加载中沿用已核实身份')
 f.state.directory={status:'failed',rows,error:Error('offline')};f.render();await settle()
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Alice','刷新失败沿用已核实身份')
 assert.deepEqual(f.calls,['A','B'],'加载中与失败快照不重读')

 // 没有可匹配的员工时无需读取关联；员工表到达后再读。
 f.state.roles=[];f.state.directory={status:'ready',rows:[conversation('A'),conversation('B')],error:undefined}
 f.render();await settle()
 assert.deepEqual(f.calls,['A','B'],'空员工表不发请求')
 assert.equal(f.titleOf('A'),'Chat A')
 f.state.roles=[{id:'alice',name:'Alice',kind:'employee',avatarKey:'squirrel-general'}]
 f.render();await settle()
 assert.deepEqual(f.calls,['A','B','A','B'],'员工表到达后按新代次重读')
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Alice')
})

test('新目录代次、员工表变化与人工刷新都会重读；未核实前不显示旧身份，迟到的旧代结果不覆盖新代',async t=>{
 const f=fixture(t)
 f.render();await settle()
 assert.deepEqual(f.calls,['A','B'])

 // 目录增删：新代次按当前全部会话重读（含被筛选隐藏的会话）。
 f.state.directory={status:'ready',rows:[conversation('A'),conversation('B'),conversation('C')],error:undefined}
 f.render();await settle()
 assert.deepEqual(f.calls,['A','B','A','B','C'])
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Alice')

 // 人工刷新得到同一批会话的新代次：仍重读；读完前不显示上一代身份。
 f.hold(true)
 f.state.directory={status:'ready',rows:[conversation('A'),conversation('B'),conversation('C')],error:undefined}
 f.render();await settle()
 assert.deepEqual(f.calls.slice(5),['A','B','C'],'人工刷新重读')
 assert.equal(f.titleOf('A'),'Chat A','未核实的新代次不显示旧员工')

 // 关联变更后再刷新：新代次（Bob）先回；旧代次（Alice）迟到不覆盖。
 f.state.roles=[...f.state.roles,{id:'bob',name:'Bob',kind:'employee',avatarKey:'squirrel-general'}]
 f.state.directory={status:'ready',rows:[conversation('A'),conversation('B'),conversation('C')],error:undefined}
 f.render();await settle()
 assert.deepEqual(f.calls.slice(8),['A','B','C'])
 assert.equal(f.pendingReads(),6,'两代读取都在途')
 // 新代次先回：A 已改绑 Bob。
 f.release('last',3,'bob')
 await settle();await settle()
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Bob')
 // 旧代次迟到：仍答 Alice，不得覆盖已核实的 Bob。
 f.release('first',3,'alice')
 await settle();await settle()
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Bob','旧代迟到结果不覆盖新代')
 assert.equal(f.titleOf('C'),'Chat C')
 assert.equal(f.pendingReads(),0)
})

test('N48 员工分类按真实员工会话关联划分：员工单聊只在员工，普通会话只在会话，未核实前不冒认员工',async t=>{
 const f=fixture(t)
 f.render();await settle()
 assert.equal(f.type(),'session','默认会话分类')
 assert.deepEqual(f.visible(),['B'],'会话分类不混入员工单聊')
 const select=(key:'session'|'employee'|'group')=>{f.control(node=>node.type==='button'&&node.children.includes(dialogueCopy.dialogueCopy('en',key))).props.onClick();f.render()}
 select('employee');assert.deepEqual(f.visible(),['A'],'员工分类只含有真实员工关联的会话')
 select('group');assert.deepEqual(f.visible(),[])
 assert.deepEqual(f.calls,['A','B'],'切换分类不重读身份')
 // 名称像员工也不猜：只看关联。
 f.hold(true);f.state.directory={status:'ready',rows:[conversation('A'),conversation('B'),{...conversation('Alice'),title:'Alice'}],error:undefined}
 select('employee');await settle()
 assert.deepEqual(f.visible(),[],'新代次未核实前员工分类不显示旧身份')
 select('session');assert.deepEqual(f.visible().sort(),['A','Alice','B'],'未核实的会话留在会话分类，不隐藏')
 f.release('first',3,'alice');await settle();await settle()
 assert.deepEqual(f.visible().sort(),['Alice','B'],'标题叫 Alice 的普通会话仍在会话')
 select('employee');assert.deepEqual(f.visible(),['A'])
})

test('N48 跳到具体员工会话或群时选中对应分类，避免隐藏当前对象；之后本人仍可自行切换',async t=>{
 const f=fixture(t)
 f.state.current='A';f.render();await settle();f.render()
 assert.equal(f.type(),'employee','当前是员工单聊：选中员工分类')
 assert.ok(f.visible().includes('A'))
 const select=(key:'session'|'employee'|'group')=>{f.control(node=>node.type==='button'&&node.children.includes(dialogueCopy.dialogueCopy('en',key))).props.onClick();f.render()}
 select('session');f.render();await settle();f.render()
 assert.equal(f.type(),'session','同一当前对象不反复抢回分类')
 f.state.current='B';f.render();await settle();f.render()
 assert.equal(f.type(),'session')
 select('employee');f.state.current='B2';f.state.directory={...f.state.directory,rows:[...f.state.directory.rows,conversation('B2')]};f.render();await settle();f.render()
 assert.equal(f.type(),'session','跳到普通会话：选中会话分类')
 f.state.current=undefined;f.state.selectedGroup='g1';f.render();await settle();f.render()
 assert.equal(f.type(),'group','打开群：选中群分类')
 // 过渡：残留的群目标仍在，但单聊已实际可见，以可见单聊为准，不被推回群。
 f.state.current='A';f.render();await settle();f.render()
 assert.equal(f.type(),'employee','可见员工单聊优先于残留群目标')
 f.render();await settle();f.render();assert.equal(f.type(),'employee','不被残留群目标反复推回')
})

test('N48 员工单聊首条消息前仍跟随员工分类，不因空白会话尚未入列表而漏读当前身份',async t=>{
 const f=fixture(t)
 f.state.native={byId:{A:{id:'A',title:'新员工单聊',running:false,blank:true,updatedAt:1}},ids:['A']}
 f.state.current='A';f.render();await settle();f.render()
 assert.ok(f.calls.includes('A'),'当前空白会话仍经真实对象关联核验身份')
 assert.equal(f.type(),'employee','未发送第一条消息也应跟随员工分类')
 assert.equal(f.visible().includes('A'),false,'不为分类伪造已开始的历史行')
 f.control(node=>node.type==='button'&&node.children.includes(dialogueCopy.dialogueCopy('en','session'))).props.onClick()
 f.render();await settle();f.render()
 assert.equal(f.type(),'session','之后本人仍可自行切换分类')
})

test('N48 身份读取失败或歧义：会话留在会话分类可达、不冒认员工；刷新得到新目录代次后重新核验并归入员工',async t=>{
 const f=fixture(t),failing=new Set(['A'])
 f.replaceApi({bySession:(id:string)=>{f.calls.push(id);return failing.has(id)?Promise.reject(Error('offline')):Promise.resolve([])}})
 f.render();await settle();f.render()
 assert.deepEqual(f.visible().sort(),['A','B'],'读取失败的会话仍在会话分类可达')
 failing.clear()
 f.replaceApi({bySession:(id:string)=>{f.calls.push(id);return Promise.resolve(id==='A'?[{kind:'role' as const,sessionId:id,objectId:'alice',active:true as const}]:[])}})
 f.state.directory={...f.state.directory,rows:[conversation('A'),conversation('B')]};f.render();await settle();f.render()
 assert.deepEqual(f.visible(),['B'],'重新核验后员工单聊离开会话分类')
 assert.equal(f.titleOf('A'),'conversationDirectory.employeeTitle:Alice')
})
