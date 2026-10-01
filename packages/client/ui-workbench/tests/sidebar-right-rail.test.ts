import assert from 'node:assert/strict'
import test from 'node:test'
import type {TabId,TabRecord} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {createRailTabs,railTargetKey,type RailFace,type RailTabs} from '../src/client/sidebar-right-rail.ts'
import {
 publishTeloaTabHost,retractTeloaTabHost,notifyTeloaTabHost,subscribeTeloaTabHost,teloaTabHost,teloaTabHostRevision,
 type TeloaTabHost,
} from '../src/client/sidebar-right-tab-host.ts'
import {tabToDetailTarget} from '../src/client/sidebar-right-tabs.ts'
import type {WorkbenchDetailTarget} from '../src/client/workbench-detail-target.ts'

/** Teloa 自己的页类型。 */
const mine=(kind:string)=>kind.startsWith('teloa.')
const id=(value:string)=>value as unknown as TabId

const task=(id:string):WorkbenchDetailTarget=>({kind:'conversation-object',sessionId:'s1',objectKind:'task',id})
const space=():WorkbenchDetailTarget=>({kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope:'SOC',section:'overview'}})

/**
 * 桩右栏，按 DSH 的真实契约建模五件事：
 * 1. `openTab()` 不回传新页签 id，`active()` 读的是**上一次提交**的快照，所以开完页签当场取到的仍是旧值；
 * 2. `multiple:false` 的同 kind 再开一次走「揭示既有页签」：**不跑关闭钩子、也不换 tab id**；
 * 3. 换 kind 的 `replaceTab` 先跑被替换页签的关闭钩子、再提交新页签；
 * 4. 每个会话（surface）自己铸造 tab id，计数器都从 `tab1` 起，所以跨会话必然重号；
 * 5. `replaceTab` 指到本会话没有的 id 时 `findTabPane` 直接抛。
 *
 * 另外建模座位寿命：DockKit 每个 pane 只挂载活动页签的正文，切走即卸载（`unmountSeat`）。
 */
function stubRail(initial?:{id:string;kind:string}){
 const record=(value:{id:string;kind:string})=>({id:id(value.id),kind:value.kind,contentId:'c-'+value.id,title:'t-'+value.id}) as TabRecord
 type Surface={tabs:Map<string,{id:string;kind:string}>;activeId?:string|undefined;pending?:{id:string;kind:string}|undefined;reveal?:string|undefined;serial:number}
 const surfaces=new Map<string,Surface>()
 let live='s1'
 const enter=(session:string,seed?:{id:string;kind:string})=>{
  live=session
  let found=surfaces.get(session)
  if(found)return found
  found={tabs:new Map(),serial:0}
  // 种进去的官方页签也是这个会话自己的计数器铸的，所以计数器要跟着走一格。
  if(seed){found.tabs.set(seed.id,seed);found.activeId=seed.id;found.serial=1}
  surfaces.set(session,found)
  return found
 }
 enter('s1',initial)
 const now=()=>surfaces.get(live)!
 let onReplace:((kind:string)=>void)|undefined
 const calls:string[]=[]
 const face:RailFace={
  active:()=>{const surface=now();const current=surface.activeId!==undefined&&surface.tabs.get(surface.activeId);return current?record(current):undefined},
  openTab:(kind,options)=>{
   calls.push('openTab:'+kind+':'+JSON.stringify(options?.params??null)+':'+String(options?.replaceTab??''))
   const surface=now()
   let replaced:{id:string;kind:string}|undefined
   if(options?.replaceTab!==undefined){
    replaced=surface.tabs.get(String(options.replaceTab))
    // 本会话的布局里没有这个 id：DSH 的 findTabPane 直接抛。
    if(!replaced)throw Error('findTabPane: 未知页签 '+String(options.replaceTab))
   }
   // 同 kind：pages 在目标 pane 内去重，等于揭示既有页签，既不关它也不换 id。
   if(replaced&&replaced.kind===kind){surface.reveal=replaced.id;return}
   if(replaced){onReplace?.(replaced.kind);surface.tabs.delete(replaced.id)}
   // 每个会话自己的计数器：都从 tab1 起，跨会话必然重号。
   surface.pending={id:'tab'+(++surface.serial),kind}
  },
  close:tabId=>{calls.push('close:'+String(tabId));now().tabs.delete(String(tabId))},
 }
 return {
  face,calls,
  /** 被替换页签的关闭钩子。 */
  onReplace(handler:(kind:string)=>void){onReplace=handler},
  /** 切到另一个会话的 surface；第一次进去可以带上这个会话自己的官方页签。 */
  enter(session:string,seed?:{id:string;kind:string}){enter(session,seed)},
  /** 模拟下一次提交：新开的页签这时才成为活动页签，座位也才挂载得起来。 */
  commit(){
   const surface=now()
   if(surface.pending){surface.tabs.set(surface.pending.id,surface.pending);surface.activeId=surface.pending.id;surface.pending=undefined}
   else if(surface.reveal){surface.activeId=surface.reveal;surface.reveal=undefined}
   return surface.activeId
  },
  /** 模拟用户点另一个页签：那个页签成为活动页签，原来的 Teloa 座位随之卸载。 */
  activate(tabId:string){now().activeId=tabId},
  tabIds:()=>[...now().tabs.keys()],
 }
}

/** 座位挂载：把自己的真实 tab id 回报给记账器。卸载刻意不做任何事——这正是 N-1 要钉的。 */
const mountSeat=(rail:RailTabs,session:string,kind:string,tabId:string)=>rail.bindTab(session,kind,id(tabId))

test('开页签不抢官方页签的位；已有 Teloa 页签时让它让位',()=>{
 const terminal=stubRail({id:'term-1',kind:'dsh.terminal'})
 createRailTabs(()=>terminal.face,mine).open('s1','teloa.task',{taskId:'t1'},task('t1'))
 assert.deepEqual(terminal.calls,['openTab:teloa.task:'+JSON.stringify({taskId:'t1'})+':'],'终端不该被顶掉')

 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 const taskTab=stub.commit()!
 mountSeat(rail,'s1','teloa.task',taskTab)
 rail.open('s1','teloa.task',{taskId:'t2'},task('t2'))
 assert.equal(stub.calls.at(-1),'openTab:teloa.task:'+JSON.stringify({taskId:'t2'})+':'+taskTab)
})

test('不允许两个 Teloa 页签并存：活动页签是终端时开业务，让位的是任务页签',()=>{
 const stub=stubRail({id:'term-1',kind:'dsh.terminal'})
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 const taskTab=stub.commit()!
 mountSeat(rail,'s1','teloa.task',taskTab)
 // 用户切回终端：Teloa 座位卸载，但任务页签还在条上。
 stub.activate('term-1')
 rail.open('s1','teloa.business',{scope:'SOC',section:'overview'},space())
 assert.equal(stub.calls.at(-1),'openTab:teloa.business:'+JSON.stringify({scope:'SOC',section:'overview'})+':'+taskTab)
 assert.ok(stub.tabIds().includes('term-1'),'终端必须原样留着')
 assert.equal(rail.size(),1,'任何时刻至多一个 Teloa 页签在账上')
})

test('座位卸载不注销：切到终端后仍能收起自己的页签',()=>{
 const stub=stubRail({id:'term-1',kind:'dsh.terminal'})
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 const taskTab=stub.commit()!
 mountSeat(rail,'s1','teloa.task',taskTab)
 // DockKit 只挂载活动页签的正文：点一下终端，Teloa 座位就卸载了（卸载不做任何事）。
 stub.activate('term-1')
 rail.closeCurrent('s1')
 assert.deepEqual(stub.calls.filter(call=>call.startsWith('close:')),['close:'+taskTab])
 assert.ok(stub.tabIds().includes('term-1'))
 assert.equal(rail.size(),0)
})

test('关闭钩子按 kind 比对：跨 kind 导航不抹掉刚写好的详情，关掉新页签才收',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 mountSeat(rail,'s1','teloa.task',stub.commit()!)
 rail.open('s1','teloa.business',{scope:'SOC',section:'overview'},space())
 assert.equal(rail.release('s1','teloa.task'),false,'旧页签的关闭钩子不该收走新详情')
 assert.equal(rail.release('s1','teloa.business'),true,'关掉现在这个页签才收')
 assert.equal(rail.release('s1','teloa.role'),false,'认不得的页类型一律不收')
})

test('跨 kind 替换时旧钩子跑在提交之前；同 kind 走揭示，既不跑钩子也不换 id',()=>{
 const crossing=stubRail()
 const crossRail=createRailTabs(()=>crossing.face,mine)
 const crossed:boolean[]=[]
 crossing.onReplace(replaced=>crossed.push(crossRail.release('s1',replaced)))
 crossRail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 mountSeat(crossRail,'s1','teloa.task',crossing.commit()!)
 crossRail.open('s1','teloa.business',{scope:'SOC',section:'overview'},space())
 assert.deepEqual(crossed,[false],'旧钩子不该收走刚写好的详情')
 assert.equal(crossRail.release('s1','teloa.business'),true,'新页签仍在账上')

 const same=stubRail()
 const sameRail=createRailTabs(()=>same.face,mine)
 const revealed:boolean[]=[]
 same.onReplace(replaced=>revealed.push(sameRail.release('s1',replaced)))
 sameRail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 const taskTab=same.commit()!
 mountSeat(sameRail,'s1','teloa.task',taskTab)
 sameRail.open('s1','teloa.task',{taskId:'t2'},task('t2'))
 assert.deepEqual(revealed,[],'同 kind 是揭示既有页签，不跑关闭钩子')
 assert.equal(same.commit(),taskTab,'tab id 不变')
 // 登记仍然有效：收起时关的就是这个页签。
 sameRail.closeCurrent('s1')
 assert.equal(same.calls.at(-1),'close:'+taskTab)
})

test('收起当前详情的页签：按详情身份找 kind，再用座位回报的 id 关',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 const taskTab=stub.commit()!
 mountSeat(rail,'s1','teloa.task',taskTab)
 rail.closeCurrent('s1')
 assert.equal(stub.calls.at(-1),'close:'+taskTab)
 const before=stub.calls.length
 rail.closeCurrent('s1')
 assert.equal(stub.calls.length,before,'账已清空，不再重复关')
})

test('座位没回报 id 时不瞎关；新的回报顶替旧的；release 一并清掉登记',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 rail.closeCurrent('s1')
 assert.deepEqual(stub.calls.filter(call=>call.startsWith('close:')),[],'不知道 id 就什么都不做')

 rail.open('s1','teloa.task',{taskId:'t2'},task('t2'))
 mountSeat(rail,'s1','teloa.task','old')
 mountSeat(rail,'s1','teloa.task','new')
 rail.closeCurrent('s1')
 assert.equal(stub.calls.at(-1),'close:new')

 // release 之后登记也没了：下一次开页签不会拿已经关掉的页签去 replaceTab。
 rail.open('s1','teloa.task',{taskId:'t3'},task('t3'))
 mountSeat(rail,'s1','teloa.task','third')
 assert.equal(rail.release('s1','teloa.task'),true)
 rail.open('s1','teloa.task',{taskId:'t4'},task('t4'))
 assert.equal(stub.calls.at(-1),'openTab:teloa.task:'+JSON.stringify({taskId:'t4'})+':')
})

test('第二次 open 之前座位没回报 id：旧账被 drop，账本不会留两笔（MEDIUM-C 回归）',()=>{
 // 判"本会话已有 Teloa 页签"要问 targets，不能问 ids：页签开进折叠/非活动 pane、
 // 正文从未挂载时 ids 拿不到号，但旧账依然是真的——这里刻意不 mountSeat 来复现这一刻。
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 rail.open('s1','teloa.business',{scope:'SOC',section:'overview'},space())
 assert.equal(rail.size('s1'),1,'旧账被 drop，账本不会留两笔')
 assert.equal(rail.release('s1','teloa.task'),false,'旧 kind 的账已经被清掉')
 assert.equal(rail.release('s1','teloa.business'),true,'新 kind 才是账上这一笔')

 rail.open('s1','teloa.task',{taskId:'t2'},task('t2'))
 // 依旧不 mountSeat；closeCurrent 得把账本清空，不留收不掉的死账。
 rail.closeCurrent('s1')
 assert.equal(rail.size('s1'),0,'closeCurrent 能清空账本，即便座位从没回报过 id')
})

test('记账按会话分本：切到另一个会话开对象，不去顶那边同号的官方页签',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 const taskTab=stub.commit()!
 assert.equal(taskTab,'tab1','每个会话的计数器都从 tab1 起，跨会话必然重号')
 mountSeat(rail,'s1','teloa.task',taskTab)
 // 用户切到会话 B：外壳不卸载，记账整份带过去，而 B 里的 tab1 是用户自己的终端。
 stub.enter('s2',{id:'tab1',kind:'dsh.terminal'})
 rail.open('s2','teloa.business',{scope:'SOC',section:'overview'},space())
 assert.equal(stub.calls.at(-1),'openTab:teloa.business:'+JSON.stringify({scope:'SOC',section:'overview'})+':','不带 replaceTab')
 assert.ok(stub.tabIds().includes('tab1'),'B 的终端必须原样留着')
 stub.commit()
 assert.equal(stub.tabIds().length,2,'终端与新页签并存')
 assert.equal(rail.size('s1'),1,'A 的账原样留着')
 assert.equal(rail.size('s2'),1)
})

test('替换只顶自己的页签：活动页签证明这个号已经归了官方页类型，就不顶它',()=>{
 const stub=stubRail({id:'tab1',kind:'dsh.terminal'})
 const rail=createRailTabs(()=>stub.face,mine)
 // 账上记着 tab1 是 Teloa 的任务页签，可 DSH 侧它其实是终端——记账过期了。
 mountSeat(rail,'s1','teloa.task','tab1')
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 assert.equal(stub.calls.at(-1),'openTab:teloa.task:'+JSON.stringify({taskId:'t1'})+':','认不出是自己的就不带 replaceTab')
 assert.ok(stub.tabIds().includes('tab1'),'终端原样留着')
})

test('记账里的 id 已经失效：清账后不带 replaceTab 重开一次',()=>{
 const stub=stubRail({id:'guide',kind:'dsh.guide'})
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 stub.commit()
 // 座位回报过的页签已经不在这个会话的布局里（别的会话的座位关掉了它），账上只剩死号。
 mountSeat(rail,'s1','teloa.task','tab9')
 rail.open('s1','teloa.task',{taskId:'t2'},task('t2'))
 assert.deepEqual(stub.calls.slice(-2),[
  'openTab:teloa.task:'+JSON.stringify({taskId:'t2'})+':tab9',
  'openTab:teloa.task:'+JSON.stringify({taskId:'t2'})+':',
 ],'第一次带死号抛错，第二次不带 replaceTab 重开')
 assert.equal(rail.size('s1'),1,'账已重建，死号不再留着')
 const reopened=stub.commit()!
 mountSeat(rail,'s1','teloa.task',reopened)
 rail.closeCurrent('s1')
 assert.equal(stub.calls.at(-1),'close:'+reopened,'重开的页签仍收得起来')
})

test('关闭钩子按会话对账：别的会话关同 kind 的页签不收这边的详情',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 assert.equal(rail.release('s2','teloa.task'),false,'账不在那本上')
 assert.equal(rail.release('s1','teloa.task'),true)
})

test('页签是真源：会话往返之后正文的“关闭”仍能关，收起也仍能收',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 const taskTab=stub.commit()!
 mountSeat(rail,'s1','teloa.task',taskTab)
 // 用户切到会话 B 再切回 A：A 的页签一直在条上，页内详情却已被切会话清成空。
 stub.enter('s2')
 stub.enter('s1')
 // 正文里的“关闭”走的就是这条关闭钩子：账上有这笔，就该把页内详情一起收掉。
 assert.equal(rail.release('s1','teloa.task'),true)
 // 再开一次并收起：不与“页内详情此刻指着谁”比对，收起照样落到真实 tab id 上。
 rail.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 mountSeat(rail,'s1','teloa.task',stub.commit()!)
 rail.closeCurrent('s1')
 assert.ok(stub.calls.filter(call=>call.startsWith('close:')).length>0,'收起必须真的关掉页签')
 assert.equal(rail.size('s1'),0)
})

test('face 缺席或抛错一律吞掉，调用方原样退回页内第三栏',()=>{
 const missing=createRailTabs(()=>undefined,mine)
 assert.equal(missing.available(),false)
 missing.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 assert.equal(missing.size(),0)
 missing.closeCurrent('s1')

 const throwing=createRailTabs(()=>{throw Error('右栏尚未就绪')},mine)
 assert.equal(throwing.available(),false)
 throwing.open('s1','teloa.task',{taskId:'t1'},task('t1'))
 throwing.closeCurrent('s1')

 const stub=stubRail()
 assert.equal(createRailTabs(()=>stub.face,mine).available(),true)
})

test('详情身份与字段书写顺序无关，store 写回与页签参数重建都得同键',()=>{
 assert.equal(railTargetKey(null),'')
 assert.notEqual(railTargetKey(task('t1')),railTargetKey(task('t2')))
 assert.equal(
  railTargetKey({objectKind:'task',id:'t1',sessionId:'s1',kind:'conversation-object'} as WorkbenchDetailTarget),
  railTargetKey(task('t1')),
 )
 // 版本不进钥匙：同一个任务的不同版本仍是同一个页签。
 assert.equal(railTargetKey({...task('t1'),version:7} as WorkbenchDetailTarget),railTargetKey(task('t1')))
 // 由页签参数重建出来的目标，与开页时用的目标同键。
 for(const [target,kind,params] of [
  [task('t1'),'teloa.task',{taskId:'t1'}],
  [space(),'teloa.business',{scope:'SOC',section:'overview'}],
 ] as const)assert.equal(railTargetKey(tabToDetailTarget(kind,params,'s1')),railTargetKey(target))
 // 分隔符不能是字段值里出现得了的字符：业务范围标签是自由文本。
 const scoped=(scope:string,section:'overview'|'data'):WorkbenchDetailTarget=>({kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope,section}})
 assert.notEqual(railTargetKey(scoped('SOC overview','data')),railTargetKey(scoped('SOC','overview')))
 assert.notEqual(railTargetKey(scoped('A:B','overview')),railTargetKey(scoped('A','overview')))
 // 成果来源的判别字段要拼全：同 id 的不同来源不能共用一把钥匙。
 const artifact=(source:{kind:'analysis';id:string;scope:string}|{kind:'object';id:string;scope:string;objectType:string}):WorkbenchDetailTarget=>({kind:'artifact',source})
 assert.notEqual(
  railTargetKey(artifact({kind:'object',id:'o1',scope:'SOC',objectType:'asset'})),
  railTargetKey(artifact({kind:'object',id:'o1',scope:'SOC',objectType:'alert'})),
 )
 assert.notEqual(
  railTargetKey(artifact({kind:'analysis',id:'a1',scope:'SOC'})),
  railTargetKey(artifact({kind:'analysis',id:'a1',scope:'AppSec'})),
 )
})

test('刷新恢复只发生一次：第一次够条件之后，用户自己的开关不再被覆盖',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 assert.equal(rail.restoreOnce('s1',{kind:'teloa.task',params:{taskId:'t1'},target:task('t1')}),true)
 assert.equal(rail.restoreOnce('s1',{kind:'teloa.task',params:{taskId:'t2'},target:task('t2')}),false)
 assert.equal(stub.calls.filter(call=>call.startsWith('openTab:')).length,1)
})

test('没有可恢复的目标就没用掉名额：真有目标那次才算恢复过',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,mine)
 assert.equal(rail.restoreOnce('s1',null),false)
 assert.equal(stub.calls.length,0,'没东西可恢复就什么都不开')
 assert.equal(rail.restoreOnce('s1',{kind:'teloa.task',params:{taskId:'t1'},target:task('t1')}),true)
 assert.equal(rail.restoreOnce('s1',{kind:'teloa.task',params:{taskId:'t2'},target:task('t2')}),false,'恢复过就不再覆盖用户自己的开关')
 assert.equal(stub.calls.filter(call=>call.startsWith('openTab:')).length,1)
})

const host=(overrides:Partial<TeloaTabHost>={}):TeloaTabHost=>({
 render:()=>null,hasEvidence:()=>false,label:()=>undefined,bindTab:()=>{},releaseTab:()=>{},...overrides,
})

test('注册表只认自己发布的那一份，重复发布同一份不额外通知',t=>{
 t.after(()=>retractTeloaTabHost(undefined))
 let notified=0
 const off=subscribeTeloaTabHost(()=>{notified++})
 t.after(off)
 const first=host()
 publishTeloaTabHost(first)
 assert.equal(teloaTabHost(),first)
 assert.equal(notified,1)
 publishTeloaTabHost(first)
 assert.equal(notified,1,'同一份不再通知')

 const second=host()
 publishTeloaTabHost(second)
 assert.equal(teloaTabHost(),second)
 // 上一任外壳卸载得晚：收回时不能把后继者清掉。
 retractTeloaTabHost(first)
 assert.equal(teloaTabHost(),second)
 retractTeloaTabHost(second)
 assert.equal(teloaTabHost(),undefined)
})

test('版本号只在真有座位听着时前进；没有宿主、没有订阅者时通知都是空操作',t=>{
 t.after(()=>retractTeloaTabHost(undefined))
 const before=teloaTabHostRevision()
 notifyTeloaTabHost()
 assert.equal(teloaTabHostRevision(),before,'没有宿主时不该前进')
 publishTeloaTabHost(host())
 assert.equal(teloaTabHostRevision(),before,'没有座位订阅时前进版本号只会白白让后来的座位重绘')
 const off=subscribeTeloaTabHost(()=>{});t.after(off)
 notifyTeloaTabHost()
 assert.equal(teloaTabHostRevision(),before+1)
 notifyTeloaTabHost()
 assert.equal(teloaTabHostRevision(),before+2)
})
