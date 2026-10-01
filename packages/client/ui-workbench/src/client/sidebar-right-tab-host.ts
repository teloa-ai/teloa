import type {ReactNode} from 'react'
import type {TabId} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {TeloaTabKind,TeloaTabSecondaryView} from './sidebar-right-tabs.js'

/**
 * 原生右栏页签的内容仍归 Teloa 外壳所有：DSH 提供座位，`WorkbenchFrame` 提供“画什么”。
 * 两边分处两棵 React 树，既不能传 props 也不能共用 context，因此用一份模块级注册表交接——
 * 与 `index.ts` 里 `actions` 的写法同源，整页只有一个工作台外壳，不存在第二个写入者。
 *
 * `revision` 是这份事实的版本号：外壳每次提交后自增一次，座位据此重绘，
 * 否则页签里的任务详情会停在开页那一刻的快照上。
 *
 * **立规则：页签正文所需的 React context 必须在 `.details` 轨道祖先层提供。**
 * 正文虽由本外壳画，挂载点却是 `renderSlot('rightbar')` 里的座位——只包 `<main>` 的 provider
 * 是它的兄弟而不是祖先，正文里任何 `useContext` 取不到值的组件（如 `ApprovalNotes`）当场抛，
 * 而 DSH 右栏与 dockkit 都没有 error boundary，整条右栏乃至外壳一起崩。
 * 新增 provider 时一律与 `BusinessScopeProvider` 同层包住整个 frame，不要在座位外再包一层。
 */
export type TeloaTabHost={
 /** 画一个页签的正文；参数不可用（脏参数、对象已不在）时返回 null，由座位显示“目标已不可用”。 */
 render:(kind:TeloaTabKind,view:TeloaTabSecondaryView,params:unknown)=>ReactNode
 /** 这个对象此刻有没有可核对的依据；没有就不出二级切换条。 */
 hasEvidence:(kind:TeloaTabKind,params:unknown)=>boolean
 /** 活标题：语言切换与对象改名都要能反映到页签条上。 */
 label:(kind:TeloaTabKind,params:unknown)=>string|undefined
 /**
  * 座位挂载时回报自己所在会话与自己的 tab id：`openTab` 不回传 id，`active()` 只反映上一次提交，
  * 唯一知道真实 id 的是画出来的那个座位。座位卸载时**不注销**——切到别的页签会让座位卸载，
  * 但页签仍在条上，注销就再也收不起它。
  *
  * 会话必须一并回报：tab id 由每个会话自己的计数器铸造，跨会话必然重号，
  * 不分会话记账就会拿 A 的号去顶 B 里同号的官方页签。
  */
 bindTab:(sessionId:string,kind:TeloaTabKind,tabId:TabId)=>void
 /**
  * 页签被关闭前的收尾；抛错即保留页签。
  * 按（会话, kind）判断：关闭钩子拿到的 TabRecord 不带导航参数，而且在 replaceTab 时先于新页签提交执行，
  * 不比对身份就会把刚写好的详情抹掉；别的会话关同 kind 的页签也不该动这边的详情。
  */
 releaseTab:(sessionId:string,kind:TeloaTabKind)=>void
}

let host:TeloaTabHost|undefined
let revision=0
const listeners=new Set<()=>void>()

function notify():void{
 // 没有座位挂载时没人听：外壳每次提交都会调一次，空转的版本号前进只会白白让后来的座位重绘。
 if(listeners.size===0)return
 revision++
 for(const listener of [...listeners])listener()
}

/** 与页签有关的事实变了：通知座位重绘。发布对象本身是稳定的，内容通过闭包始终取最新。 */
export function notifyTeloaTabHost():void{
 if(host!==undefined)notify()
}

/** 外壳挂载时发布一次；重复发布同一个对象不会额外通知。 */
export function publishTeloaTabHost(next:TeloaTabHost):void{
 if(host===next)return
 host=next
 notify()
}

/** 外壳卸载时收回；只收回自己发布的那一份，避免把后继者清掉。 */
export function retractTeloaTabHost(previous:TeloaTabHost|undefined):void{
 if(previous!==undefined&&host!==previous)return
 host=undefined
 notify()
}

export function teloaTabHost():TeloaTabHost|undefined{return host}
export function teloaTabHostRevision():number{return revision}
export function subscribeTeloaTabHost(listener:()=>void):()=>void{
 listeners.add(listener)
 return ()=>{listeners.delete(listener)}
}
